/*
 * Vital Bio-Card Sync — M5Stack (ESP32) + MAX30100
 *
 * MAX30100 で心拍を検知し、Firebase Realtime Database へ送信する。
 * HTTPClient で直接 REST API に送信（認証なし）
 * FreeRTOSタスクでHTTP通信をセンサー読み取りから分離
 *
 * 必要ライブラリ (Arduino Library Manager):
 *   - M5Stack
 *   - MAX30100lib (MAX30100_PulseOximeter)
 */

#include <M5Stack.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include "MAX30100_PulseOximeter.h"

// --- iPhone テザリング用 ---
#define WIFI_SSID     "YukiPhone"      // iPhoneの名前（設定→一般→情報）
#define WIFI_PASSWORD "yukihiro825"    // インターネット共有のパスワード
#define WIFI_CONNECT_TIMEOUT_MS  20000
#define DATABASE_URL  "https://dentsu-internship-art-demo-default-rtdb.asia-southeast1.firebasedatabase.app"
// iPhone: 「互換性を最大に」をON（2.4GHz）。非公開ネットワークはスキャンに出ないがSSID指定で接続は試行される

// 同一WiFi内のラグ削減（テザリング時: MacのIPは172.20.10.x）
#define USE_RELAY     1
#define RELAY_HOST    "172.20.10.5"    // テザリングで接続したMacのIP（変更時はMacでifconfig確認）
#define RELAY_PORT    8765

#define BEAT_QUEUE_SIZE  32
#define HTTP_TIMEOUT_MS  1000
#define RELAY_TIMEOUT_MS 500   // Relay未接続時に早くあきらめてFirebaseへ

typedef struct {
  unsigned long ts;
  int count;
} BeatEntry;

static BeatEntry beatQueue[BEAT_QUEUE_SIZE];
static volatile int qHead = 0;
static volatile int qTail = 0;
static volatile int qSize = 0;
static portMUX_TYPE beatQueueMux = portMUX_INITIALIZER_UNLOCKED;

static bool beatQueuePush(unsigned long ts, int count) {
  portENTER_CRITICAL(&beatQueueMux);
  if (qSize >= BEAT_QUEUE_SIZE) {
    qHead = (qHead + 1) % BEAT_QUEUE_SIZE;
    qSize--;
  }
  beatQueue[qTail].ts = ts;
  beatQueue[qTail].count = count;
  qTail = (qTail + 1) % BEAT_QUEUE_SIZE;
  qSize++;
  portEXIT_CRITICAL(&beatQueueMux);
  return true;
}

static bool beatQueuePop(unsigned long *ts, int *count) {
  portENTER_CRITICAL(&beatQueueMux);
  if (qSize == 0) {
    portEXIT_CRITICAL(&beatQueueMux);
    return false;
  }
  *ts = beatQueue[qHead].ts;
  *count = beatQueue[qHead].count;
  qHead = (qHead + 1) % BEAT_QUEUE_SIZE;
  qSize--;
  portEXIT_CRITICAL(&beatQueueMux);
  return true;
}

static bool beatQueueEmpty(void) {
  return qSize == 0;
}

PulseOximeter pox;
bool firebaseReady = false;
TaskHandle_t firebaseTaskHandle = NULL;

// 心拍メッセージ表示エリア（Ready. の下）
#define HEARTBEAT_MSG_Y  130
#define HEARTBEAT_MSG_H  24

void onBeatDetected() {
  static int count = 0;
  count++;
  Serial.printf("Heart Beat! #%d\n", count);
  beatQueuePush(millis(), count);

  // LCDに「Heart Beat! <3」を表示（行を黒でクリアしてから描画）
  M5.Lcd.fillRect(0, HEARTBEAT_MSG_Y, 320, HEARTBEAT_MSG_H, BLACK);
  M5.Lcd.setCursor(10, HEARTBEAT_MSG_Y);
  M5.Lcd.print("Heart Beat! <3");

  if (firebaseTaskHandle != NULL) {
    xTaskNotifyGive(firebaseTaskHandle);
  }
}

void firebaseTask(void *pvParameters) {
  while (true) {
    if (beatQueueEmpty()) {
      ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(10));
      continue;
    }

    unsigned long ts;
    int count;
    // キューが溜まっている場合は最新1件だけ送る（遅延した古い心拍でビジュアルが続くのを防ぐ）
    while (qSize > 1) {
      beatQueuePop(&ts, &count);
    }
    if (!beatQueuePop(&ts, &count)) continue;

#if USE_RELAY
    {
      HTTPClient http;
      String relayUrl = "http://" + String(RELAY_HOST) + ":" + String(RELAY_PORT) + "/beat";
      http.begin(relayUrl);
      http.setConnectTimeout(RELAY_TIMEOUT_MS);
      http.setTimeout(RELAY_TIMEOUT_MS);
      http.addHeader("Content-Type", "application/json");
      String body = "{\"ts\":" + String(ts) + ",\"count\":" + String(count) + "}";
      int code = http.POST(body);
      Serial.printf("    Relay: %d (#%d)\n", code, count);
      http.end();
    }
#endif

    HTTPClient http;
    http.begin(String(DATABASE_URL) + "/live/beat_timestamp.json");
    http.setConnectTimeout(HTTP_TIMEOUT_MS);
    http.setTimeout(HTTP_TIMEOUT_MS);
    http.addHeader("Content-Type", "application/json");
    String fbBody = "{\"ts\":" + String(ts) + ",\"count\":" + String(count) + "}";
    int code = http.PUT(fbBody);
    Serial.printf("    Firebase: %d (#%d)\n", code, count);
    http.end();
  }
}

void setup() {
  M5.begin();
  Serial.begin(115200);

  M5.Lcd.setTextSize(2);
  M5.Lcd.setTextColor(WHITE, BLACK);
  M5.Lcd.setCursor(10, 10);
  M5.Lcd.println("Vital Bio-Card");

  M5.Lcd.setCursor(10, 40);
  M5.Lcd.print("WiFi...");
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  delay(500);
  // 接続前にスキャン（非公開ネットワークは一覧に出ない）
  Serial.println("SSIDスキャン中...");
  int n = WiFi.scanNetworks();
  if (n >= 0) {
    Serial.printf("見つかったSSID (%d件):\n", n);
    for (int i = 0; i < n && i < 12; i++) {
      Serial.printf("  [%d] \"%s\"\n", i + 1, WiFi.SSID(i).c_str());
    }
    Serial.println("  ※非公開ネットワークは一覧に出ません。WIFI_SSIDが正しければ接続を試行します。");
    if (n == 0) {
      Serial.println("  → 0件: 「互換性を最大に」をON、または非公開の場合はこのまま接続を試行");
    }
  } else {
    Serial.printf("スキャン失敗 (code=%d). 接続は試行します\n", n);
  }
  delay(300);

  for (int attempt = 1; attempt <= 2; attempt++) {
    if (attempt == 2) {
      Serial.println("  1回目失敗。非公開ネットワーク用に再試行...");
      WiFi.disconnect();
      delay(1500);
    }
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    unsigned long wifiStart = millis();
    while (WiFi.status() != WL_CONNECTED) {
      if ((unsigned long)(millis() - wifiStart) >= WIFI_CONNECT_TIMEOUT_MS) {
        break;
      }
      delay(300);
      Serial.print(".");
    }
    if (WiFi.status() == WL_CONNECTED) break;

    int st = WiFi.status();
    Serial.printf("\nWiFi FAIL (status=%d) attempt=%d\n", st, attempt);
    if (attempt == 2) {
      Serial.println("  WL_NO_SSID_AVAIL=1: 非公開の場合はiPhoneでネットワークをブロードキャスト(公開)にすると接続しやすいです");
      Serial.println("  WL_CONNECT_FAILED=4: パスワード確認。「互換性を最大に」をON");
      M5.Lcd.println(" FAIL");
      M5.Lcd.setCursor(10, 55);
      M5.Lcd.printf("status=%d", st);
      while (1) delay(5000);
    }
  }
  Serial.println("\nWiFi connected");
  M5.Lcd.println(" OK");

  M5.Lcd.setCursor(10, 70);
  M5.Lcd.print("MAX30100...");
  if (!pox.begin()) {
    M5.Lcd.println(" FAIL");
    while (1) delay(1000);
  }
  pox.setIRLedCurrent(MAX30100_LED_CURR_50MA);
  pox.setOnBeatDetectedCallback(onBeatDetected);
  M5.Lcd.println(" OK");

  M5.Lcd.setCursor(10, 100);
  M5.Lcd.println("Ready.");
  firebaseReady = true;

  xTaskCreatePinnedToCore(firebaseTask, "FB", 8192, NULL, 1, &firebaseTaskHandle, 0);
}

void loop() {
  pox.update();
}
