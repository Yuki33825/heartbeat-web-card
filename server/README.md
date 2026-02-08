# 心拍ローカル中継（ラグ削減）

同一WiFi内で「M5Stack → PC → スマホ」にすると、Firebase 往復のラグを減らせます。

## 手順

1. **依存を入れる**  
   `npm install`

2. **中継サーバーを起動**（PCで1つ）  
   `npm run relay`  
   → `http://0.0.0.0:8765` で待ち受け

3. **このPCのIPを確認**  
   Mac: `ifconfig | grep "inet "` の `en0` の inet（例: `192.168.1.10`）

4. **M5Stack の RELAY_HOST をそのIPに**  
   `m5stack/vital_bio_card.ino` の `RELAY_HOST` を書き換えて書き込み

5. **ウェブを開く**  
   PC: `http://localhost:5173/`  
   スマホ: `http://<PCのIP>:5173/`（`npm run dev:host` で起動した場合）

スマホは中継用 WebSocket（`ws://<PCのIP>:8765`）に自動で接続し、心拍を低遅延で受け取ります。
