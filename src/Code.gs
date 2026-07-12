/**
 * LINE公式アカウント ⇔ Dify チャットボット 中継スクリプト
 *
 * 必要なスクリプトプロパティ（GAS画面「プロジェクトの設定」>「スクリプト プロパティ」で設定）:
 *   LINE_CHANNEL_ACCESS_TOKEN : LINE Developers「Messaging API設定」の チャネルアクセストークン（長期）
 *   DIFY_API_KEY              : Dify「APIアクセス」ページで発行したAPIキー（app-... の文字列）
 *   DIFY_API_BASE             : DifyのAPIベースURL（未設定なら https://api.dify.ai/v1 を使用）
 *   WEBHOOK_VERIFY_TOKEN      : （任意）Webhook URLに ?token=xxx として付与する合言葉。無関係な第三者からの呼び出しを防ぐ
 */

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
  var userId = event.source.userId;
  var userText = event.message.text;
  var replyToken = event.replyToken;

  var answer = askDify_(userText, userId, props);
  replyToLine_(replyToken, answer, props);
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
    return 'すみません、うまく回答できませんでした。しばらくしてからもう一度お試しください。';
  }

  var json = JSON.parse(response.getContentText());
  if (json.conversation_id) {
    // 会話の続き（文脈）を6時間保持する。CacheServiceの最大TTLが6時間のため
    cache.put(cacheKey, json.conversation_id, 21600);
  }

  return json.answer || '回答を取得できませんでした。';
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
