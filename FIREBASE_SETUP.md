# Firebase 側の設定手順

`sender.html` と `receiver.html` を動かすために、Firebase コンソールで行う設定です。

**このプロジェクトは npm + Vite で Firebase SDK を利用しています。** Config は `firebaseConfig.js` に記載し、開発サーバーは `npm run dev` で起動します。

---

## 1. プロジェクトを作る（まだの場合）

1. [Firebase コンソール](https://console.firebase.google.com/) にアクセス
2. **「プロジェクトを追加」** をクリック
3. プロジェクト名を入力して作成（Google アナリティクスは任意）
4. 作成完了後、そのプロジェクトを開く

---

## 2. Realtime Database を有効にする

1. 左メニュー **「Build」** → **「Realtime Database」** を開く
2. **「データベースを作成」** をクリック
3. **ロケーション**を選ぶ。Realtime Database で選べるのは次の **3つだけ** です（東京はありません）。後から変更できないので注意。
   - **アメリカ（us-central1・アイオワ）**
   - **ベルギー（europe-west1）**
   - **シンガポール（asia-southeast1）** … 日本からはレイテンシが比較的近いのでおすすめ
4. **「セキュリティルール」** で **テストモード** か **ロックモード** を選ぶ（違いは下の「テストモードとロックモード」を参照）
5. 有効化が終わると、データベースの URL が表示される（例: シンガポールなら `https://xxxxx-default-rtdb.asia-southeast1.firebasedatabase.app`）。**この URL が `databaseURL` です**

### テストモードとロックモードの選び方

| 選び方 | 意味 | このデモでのおすすめ |
|--------|------|------------------------|
| **テストモードで開始** | 作成後しばらく（約30日）、**誰でも読み書きできる**ルールで開始する。すぐ動かしたいとき向け。 | **まず動かしたいならこちら**。あとから「ルール」タブで `live` だけ許可するルールに変更すればOK。 |
| **ロックモードで開始** | 最初から**すべて拒否**。自分でルールを書かないと sender/receiver は動かない。 | 最初からルールをきちんと書きたい人向け。作成後すぐ「ルール」タブで下記の `live` 用ルールを追加する必要あり。 |

- **テストモードを選んだ場合**  
  そのまま sender/receiver が動く。運用が長くなる場合は、あとで「ルール」タブを開き、下の「4. セキュリティルール」の内容に差し替えて公開することを推奨。

- **ロックモードを選んだ場合**  
  データベース作成が終わったら、**Realtime Database → 「ルール」タブ** を開き、次のルールを貼り付けて **「公開」** する。これで `live` 以下だけ読み書き可能になり、sender/receiver が動く。

  ```json
  {
    "rules": {
      "live": {
        ".read": true,
        ".write": true
      }
    }
  }
  ```

---

## 3. ウェブアプリを登録して Config を取得する

1. 左メニュー **「プロジェクトの設定」**（歯車アイコン）を開く
2. **「全般」** タブで下にスクロールし、**「マイアプリ」** の **「</>」（ウェブ）** をクリック
3. アプリのニックネームを入力（例: `heartbeat-demo`）→ **「アプリを登録」**
4. 表示される **firebaseConfig** のオブジェクトをコピーする

   ```js
   const firebaseConfig = {
     apiKey: "AIza...",
     authDomain: "your-project.firebaseapp.com",
     databaseURL: "https://xxxxx-default-rtdb.asia-southeast1.firebasedatabase.app",
     projectId: "your-project-id",
     storageBucket: "your-project.appspot.com",
     messagingSenderId: "123456789",
     appId: "1:123456789:web:abcdef"
   };
   ```

5. プロジェクト内の **firebaseConfig.js** を開き、`firebaseConfig` オブジェクトを、このコピーした内容に**そのまま差し替え**る（`databaseURL` が入っていることを確認）

---

## 4. セキュリティルールを設定する（推奨）

**テストモードで開始した場合**は、一定期間が過ぎると「誰でも読み書きできる」状態のままでは危険という警告が出ます。**ロックモードで開始した場合**は、上でルールを追加していればそのままでOKです。

どちらの場合も、長く使うなら「`live` 以下だけ読み書き可能」に絞っておくと安全です。

1. **Realtime Database** の画面で **「ルール」** タブを開く
2. 次のように書き、**「公開」** する

   ```json
   {
     "rules": {
       "live": {
         ".read": true,
         ".write": true
       }
     }
   }
   ```

   - `live` 以下だけを公開し、それ以外のパスはデフォルトで拒否されます
   - さらに厳しくする場合は、Firebase Authentication を有効にして `auth != null` で read/write を制限できます

---

## 5. 動作確認の流れ

1. ターミナルでプロジェクトフォルダに移動し、`npm install`（初回のみ）のあと `npm run dev` を実行
2. 表示された URL（例: `http://localhost:5173`）で **sender.html** を開く
3. 別タブまたは別デバイスで **receiver.html** を開く
4. sender の画面をクリック → Firebase の **Realtime Database** の **「データ」** タブで `live/heartbeat` に `timestamp` が増えていることを確認
5. receiver 側で振動と赤フラッシュが出れば成功

---

## まとめ：Firebase でやること一覧

| やること | どこで |
|----------|--------|
| プロジェクト作成 | Firebase コンソール |
| Realtime Database 作成・ロケーション選択 | Build → Realtime Database |
| `databaseURL` を控える | 上記のデータベース URL |
| ウェブアプリ登録 | プロジェクトの設定 → マイアプリ → </> |
| Config をコピーして貼り付け | `firebaseConfig.js` の `firebaseConfig` |
| ルールで `live` だけ read/write 許可（推奨） | Realtime Database → ルール |

Config を **firebaseConfig.js** に貼り付けたら保存し、`npm run dev` で起動したサーバー経由で sender.html / receiver.html を開いて試してください。
