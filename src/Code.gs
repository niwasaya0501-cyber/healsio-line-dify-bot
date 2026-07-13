/**
 * LINE公式アカウント ⇔ Dify チャットボット 中継スクリプト
 *
 * 必要なスクリプトプロパティ（GAS画面「プロジェクトの設定」>「スクリプト プロパティ」で設定）:
 *   LINE_CHANNEL_ACCESS_TOKEN : LINE Developers「Messaging API設定」の チャネルアクセストークン（長期）
 *   DIFY_API_KEY              : Dify「APIアクセス」ページで発行したAPIキー（app-... の文字列）
 *   DIFY_API_BASE             : DifyのAPIベースURL（未設定なら https://api.dify.ai/v1 を使用）
 *   WEBHOOK_VERIFY_TOKEN      : （任意）Webhook URLに ?token=xxx として付与する合言葉。無関係な第三者からの呼び出しを防ぐ
 *   MANUAL_PDF_URL            : （任意）取扱説明書PDFの公開URL。設定するとページ番号付きリンクを返信に添える
 *   PAGES_INDEX_URL           : （任意）MANUAL_PDF_URLとセットで使う、ページ番号とページ本文の対応表(JSON)のURL
 *                               （data/pages.json をこのリポジトリのGitHub raw URLで公開したもの）
 */

// 取扱説明書PDFの各ページを抽出した際、全ページ共通で残るフッター行。
// 例: "AX-NS1A.indd   15                                       2023/03/10   10:38:55"
// Difyの引用チャンクにこの行がそのまま含まれていれば、ページ番号を直接読み取れる。
var MANUAL_FOOTER_PATTERN = /AX-NS1A\.indd\s+(\d+)\s+\d{4}\/\d{2}\/\d{2}/;

// Difyの回答がこれらの文言を含む場合は「説明書に記載なし」と判断し、ページ案内を付けない。
var NO_ANSWER_MARKERS = ['記載がない', 'お答えできません', 'わかりません', '見つかりません'];

// GASのdoPost(e)はHTTPヘッダーを取得できないため、LINEの署名検証（X-Line-Signature）は行えない。
// 代わりにWebhook URLへ付与する合言葉（WEBHOOK_VERIFY_TOKEN）で簡易的に呼び出し元を制限する。
function doPost(e) {
  try {
    var props = PropertiesService.getScriptProperties();
    var verifyToken = props.getProperty('WEBHOOK_VERIFY_TOKEN');
    if (verifyToken && (!e.parameter || e.parameter.token !== verifyToken)) {
      return ContentService.createTextOutput('forbidden');
    }

    var body = JSON.parse(e.postData.contents);
    var events = body.events || [];
    events.forEach(function (event) {
      handleEvent_(event, props);
    });
  } catch (err) {
    console.error('doPost error: ' + err);
  }
  // LINEはWebhookの応答を待つため、必ず早めに200を返す
  return ContentService.createTextOutput('ok');
}

// デプロイ後の疎通確認用（ブラウザでURLを開いて動作確認できる）
function doGet(e) {
  return ContentService.createTextOutput('LINE-Dify relay is running.');
}

function handleEvent_(event, props) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return;
  }
  var replyToken = event.replyToken;
  // LINE Developersコンソールの「検証」ボタンはreplyTokenが全て0のダミーイベントを送る。
  // Difyへの問い合わせを待つとタイムアウトするため、実処理をせず即座に抜ける。
  if (/^0+$/.test(replyToken)) {
    return;
  }

  var userId = event.source.userId;
  var userText = event.message.text;

  var result = askDify_(userText, userId, props);
  var replyText = buildReplyText_(result, props);
  replyToLine_(replyToken, replyText, props);
}

// Dify応答本文に、参照元ページの案内（📖 説明書◯ページに記載があります + PDFリンク）を付け足す。
// ページが特定できない場合や「記載なし」の回答の場合は、本文だけをそのまま返す。
function buildReplyText_(result, props) {
  var manualPdfUrl = props.getProperty('MANUAL_PDF_URL');
  if (!manualPdfUrl || !result.topResource || looksLikeNoAnswer_(result.answer)) {
    return result.answer;
  }

  var page = findPageForContent_(result.topResource.content, props);
  if (!page) {
    return result.answer;
  }

  return result.answer + '\n\n📖 説明書' + page + 'ページに記載があります\n' + manualPdfUrl + '#page=' + page;
}

function looksLikeNoAnswer_(text) {
  return NO_ANSWER_MARKERS.some(function (marker) {
    return String(text).indexOf(marker) !== -1;
  });
}

// n-gram（連続N文字の部分文字列）の一致数でページを推定する際の文字数。
// Difyの抽出結果と手元のpdftotext抽出結果は改行位置や記号表現が微妙に異なるため、
// 完全な部分文字列一致ではなく短いn-gram単位の一致率で近さを測る。
var PAGE_MATCH_NGRAM_SIZE = 8;
// 一致とみなす最低スコア（誤検出でページ案内を出さないための安全マージン）
var PAGE_MATCH_MIN_SCORE = 15;
var PAGE_MATCH_MIN_RATIO = 0.15;

// Difyの引用チャンク本文(content)から、取扱説明書の該当ページ番号を特定する。
// 1) チャンクに抽出時のフッター行がそのまま残っていれば、そこから直接ページ番号を読み取る
// 2) 残っていなければ、ページ本文対応表(pages.json)とのn-gram一致率でページを推定する
// どちらの方法でも確信を持って特定できない場合は null を返す（＝ページ案内を付けない）。
function findPageForContent_(content, props) {
  var footerMatch = content.match(MANUAL_FOOTER_PATTERN);
  if (footerMatch) {
    return parseInt(footerMatch[1], 10);
  }

  var pagesIndexUrl = props.getProperty('PAGES_INDEX_URL');
  if (!pagesIndexUrl) {
    return null;
  }

  var normalizedContent = normalizeForMatch_(content);
  if (normalizedContent.length < PAGE_MATCH_NGRAM_SIZE) {
    return null;
  }

  var pagesIndex = getPagesIndex_(pagesIndexUrl);
  if (pagesIndex.length === 0) {
    return null;
  }

  var contentGrams = buildNgramSet_(normalizedContent, PAGE_MATCH_NGRAM_SIZE);
  var contentGramKeys = Object.keys(contentGrams);
  if (contentGramKeys.length === 0) {
    return null;
  }

  var scores = {};
  contentGramKeys.forEach(function (gram) {
    pagesIndex.forEach(function (p) {
      if (p.grams[gram]) {
        scores[p.page] = (scores[p.page] || 0) + 1;
      }
    });
  });

  var bestPage = null;
  var bestScore = 0;
  Object.keys(scores).forEach(function (pageNum) {
    if (scores[pageNum] > bestScore) {
      bestScore = scores[pageNum];
      bestPage = parseInt(pageNum, 10);
    }
  });

  var ratio = bestScore / contentGramKeys.length;
  if (bestScore < PAGE_MATCH_MIN_SCORE || ratio < PAGE_MATCH_MIN_RATIO) {
    return null;
  }

  return bestPage;
}

// ページ本文対応表(pages.json)を取得し、突き合わせ用にn-gram化して返す。
// 例: [{ "page": 15, "text": "..." }, ...] -> [{ page: 15, grams: { "abcdefgh": true, ... } }, ...]
function getPagesIndex_(pagesIndexUrl) {
  var response = UrlFetchApp.fetch(pagesIndexUrl, { muteHttpExceptions: true });
  if (response.getResponseCode() !== 200) {
    console.error('pages index fetch error (' + response.getResponseCode() + ')');
    return [];
  }

  var pages = JSON.parse(response.getContentText());
  return pages.map(function (p) {
    return { page: p.page, grams: buildNgramSet_(normalizeForMatch_(p.text), PAGE_MATCH_NGRAM_SIZE) };
  });
}

function normalizeForMatch_(text) {
  return String(text).replace(/\s+/g, '');
}

// n-gram（連続N文字の部分文字列）をキーとするオブジェクトを、O(1)検索用の集合として返す。
function buildNgramSet_(text, n) {
  var grams = {};
  for (var i = 0; i + n <= text.length; i++) {
    grams[text.substr(i, n)] = true;
  }
  return grams;
}

function askDify_(query, userId, props) {
  var apiBase = props.getProperty('DIFY_API_BASE') || 'https://api.dify.ai/v1';
  var apiKey = props.getProperty('DIFY_API_KEY');
  var cache = CacheService.getScriptCache();
  var cacheKey = 'dify_conv_' + userId;
  var conversationId = cache.get(cacheKey) || '';

  var payload = {
    inputs: {},
    query: query,
    response_mode: 'blocking',
    conversation_id: conversationId,
    user: userId
  };

  var response = UrlFetchApp.fetch(apiBase + '/chat-messages', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + apiKey },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  var code = response.getResponseCode();
  if (code !== 200) {
    console.error('Dify API error (' + code + '): ' + response.getContentText());
    return { answer: 'すみません、うまく回答できませんでした。しばらくしてからもう一度お試しください。', topResource: null };
  }

  var json = JSON.parse(response.getContentText());
  if (json.conversation_id) {
    // 会話の続き（文脈）を6時間保持する。CacheServiceの最大TTLが6時間のため
    cache.put(cacheKey, json.conversation_id, 21600);
  }

  var retrieverResources = json.metadata && json.metadata.retriever_resources;
  var topResource = (retrieverResources && retrieverResources.length > 0) ? retrieverResources[0] : null;

  return { answer: json.answer || '回答を取得できませんでした。', topResource: topResource };
}

function replyToLine_(replyToken, text, props) {
  var accessToken = props.getProperty('LINE_CHANNEL_ACCESS_TOKEN');

  UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + accessToken },
    payload: JSON.stringify({
      replyToken: replyToken,
      messages: [{ type: 'text', text: String(text).slice(0, 5000) }]
    }),
    muteHttpExceptions: true
  });
}
