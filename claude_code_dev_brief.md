# 「触診する名刺」開発指示書 for Claude Code

## プロジェクト概要
電通「テクノロジーとアイデアの学校」ART日発表用
**Zoom画面共有でプレゼン（1分以内）**

### コンセプト
「相手のスマホは、私の一部になる」
名刺交換を、デバイス越しの「擬似的な身体の共有」体験に変換する

---

## 実装要件

### 必須機能（MVP）
1. **Webアプリ（ブラウザベース）**
   - URLアクセスで即起動（インストール不要）
   - モバイルファーストUI
   - タッチイベント検出（位置・圧力・継続時間）

2. **ビジュアル表現**
   - タッチした場所が「皮膚」のように変形・滲む
   - 流体シミュレーション（Navier-Stokes）
   - 触れている時間に応じて色が「赤く」加熱
   - 指を離した後に「体温」のような残像が消えていく

3. **ハプティクスフィードバック**
   - iOS: `use-haptic`ライブラリ（checkbox switchハック）
   - Android: `navigator.vibrate()`
   - タップ時に「心拍」のような短い振動

4. **サウンド**
   - Web Audio APIで心拍音をリアルタイム生成
   - タッチ時に低音（Sub-bass）が増す
   - 「吐息」のようなホワイトノイズをフィルタで混ぜる

5. **リアルタイム同期（オプション：時間があれば）**
   - PartyKitでブラウザ間通信
   - 他の人がタッチした位置にも反応

### Nice-to-have（時間があれば）
- M5Stack連携（Firebase RTDB経由で物理振動）
- 「一期一会の波形」保存機能（URLパラメータでリプレイ可能）
- タッチ軌跡から音楽生成

---

## 技術スタック

### フレームワーク
```json
{
  "runtime": "Next.js 15 (App Router)",
  "ui": "React 18 + TypeScript",
  "styling": "Tailwind CSS",
  "3d": "React Three Fiber (@react-three/fiber) + Three.js",
  "deployment": "Vercel"
}
```

### 重要ライブラリ

#### 1. 流体シミュレーション
- **ベース**: Pavel DobryakovのWebGL Fluid Simulation
  - GitHub: https://github.com/PavelDoGreat/WebGL-Fluid-Simulation
  - モバイルで60fps実績あり
  - WebGL2ベース（WebGPUは時間的リスク大）

#### 2. ハプティクス
```bash
npm install use-haptic  # iOS Safari用
```
- iOS 18+: checkbox switchハックで振動可能
- Android: 標準の`navigator.vibrate([50, 30, 50])`

#### 3. リアルタイム通信（オプション）
```bash
npm install partykit partysocket
```
- Cloudflare edge-basedで低レイテンシ
- セットアップ簡単

#### 4. Web Audio（標準API、ライブラリ不要）

---

## 実装アーキテクチャ

### ディレクトリ構成
```
/app
  /page.tsx              # ランディング（QRコード表示用）
  /touch
    /page.tsx            # メイン体験画面
    /components
      /FluidCanvas.tsx   # 流体シミュレーション
      /HapticProvider.tsx # ハプティクス管理
      /HeartbeatAudio.tsx # 音声生成
/public
  /shaders
    /fluid-vert.glsl
    /fluid-frag.glsl
/lib
  /fluid-sim.ts          # 流体シミュレーションロジック
  /audio-engine.ts       # Web Audio管理
```

### データフロー
```
Touch Event
  ↓
1. FluidCanvas: 流体に力を加える (splat)
2. HapticProvider: 振動トリガー
3. HeartbeatAudio: 心拍音の周波数・音量を変調
  ↓
(オプション) PartySocket: 他のブラウザに送信
```

---

## 実装ステップ（優先順位順）

### Phase 1: 最小動作版（3-4時間）
1. Next.jsプロジェクト作成
2. Pavel Dobryakov流体シミュレーションを`/lib`に移植
   - `fluid-sim.ts`にクラス化
   - React Three FiberのuseFrameで更新ループ
3. タッチイベント → 流体への力の追加
4. 基本的な色の変化（タッチ → 赤く）

### Phase 2: 五感フィードバック（2-3時間）
5. `use-haptic`の統合（iOS）
6. `navigator.vibrate()`フォールバック（Android）
7. Web Audio APIで心拍音生成
   - OscillatorNode (60Hz) + GainNode
   - タッチ時にgainを上げる
8. ホワイトノイズ + BiquadFilter（吐息表現）

### Phase 3: 演出強化（2時間）
9. 「体温」残像エフェクト（タッチ後3秒かけて消える）
10. ヒートマップ的な色遷移（青→赤→白）
11. 画面全体の視覚フィードバック（iOS振動効かない場合の冗長化）

### Phase 4: リアルタイム同期（オプション、2-3時間）
12. PartyKitサーバー作成
13. ブラウザ間でタッチデータ送受信
14. 他人のタッチを別の色で表示

---

## Pavel Dobryakov流体シミュレーションの移植ガイド

### 元のコード構造
```javascript
// index.htmlから抜粋
class GLProgram {
  constructor(vertexShader, fragmentShader) { ... }
}

function createFBO(w, h, format, type, filtering) { ... }

// メインループ
function update() {
  // 1. advection (速度場の移流)
  // 2. divergence (発散計算)
  // 3. pressure (圧力解法 Jacobi反復)
  // 4. gradient subtraction (速度補正)
  // 5. rendering (dye texture描画)
  requestAnimationFrame(update);
}
```

### React Three Fiberへの移植方針
```tsx
// FluidCanvas.tsx
import { useFrame, useThree } from '@react-three/fiber';
import { useRef, useEffect } from 'react';

export function FluidCanvas() {
  const { gl } = useThree();
  const simRef = useRef<FluidSimulation>();

  useEffect(() => {
    simRef.current = new FluidSimulation(gl);
    return () => simRef.current?.dispose();
  }, [gl]);

  useFrame(() => {
    simRef.current?.update();
  });

  // タッチイベント
  const handleTouch = (e: TouchEvent) => {
    const touch = e.touches[0];
    const x = touch.clientX / window.innerWidth;
    const y = 1.0 - touch.clientY / window.innerHeight;
    simRef.current?.splat(x, y, 0, 0, [1, 0, 0]); // 赤色
  };

  return <mesh onPointerDown={handleTouch}>...</mesh>;
}
```

### 重要なシェーダーパラメータ
```glsl
// fluid-frag.glsl (抜粋)
uniform float dissipation;  // 0.97 = ゆっくり消える
uniform float viscosity;    // 粘性 (0.0001 = 水, 0.01 = ゼリー)
uniform int iterations;     // 圧力反復回数 (モバイル: 20, PC: 50)
```

### モバイル最適化設定
```typescript
const config = {
  SIM_RESOLUTION: 128,      // 物理解像度
  DYE_RESOLUTION: 512,      // 描画解像度
  DENSITY_DISSIPATION: 0.97,
  VELOCITY_DISSIPATION: 0.98,
  PRESSURE_ITERATIONS: 20,  // モバイル用削減
  CURL: 30,
  SPLAT_RADIUS: 0.25 / window.innerHeight,
};
```

---

## Web Audio API実装例

```typescript
// audio-engine.ts
export class HeartbeatAudio {
  private ctx: AudioContext;
  private oscillator: OscillatorNode;
  private gainNode: GainNode;
  private noiseNode: AudioBufferSourceNode;
  private filter: BiquadFilterNode;

  constructor() {
    this.ctx = new AudioContext();

    // 心拍音（低音パルス）
    this.oscillator = this.ctx.createOscillator();
    this.oscillator.frequency.value = 60; // Sub-bass
    this.gainNode = this.ctx.createGain();
    this.gainNode.gain.value = 0;

    this.oscillator.connect(this.gainNode);
    this.gainNode.connect(this.ctx.destination);
    this.oscillator.start();

    // 吐息（ホワイトノイズ）
    this.noiseNode = this.createNoise();
    this.filter = this.ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 200;

    this.noiseNode.connect(this.filter);
    this.filter.connect(this.ctx.destination);
  }

  // タッチ時に心拍音を「ドクン」と鳴らす
  pulse() {
    const now = this.ctx.currentTime;
    this.gainNode.gain.cancelScheduledValues(now);
    this.gainNode.gain.setValueAtTime(0.3, now);
    this.gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.15);
  }

  // タッチ継続中、フィルターを開いて「吐息」感
  setBreathIntensity(intensity: number) {
    const now = this.ctx.currentTime;
    this.filter.frequency.linearRampToValueAtTime(200 + intensity * 1000, now + 0.1);
  }

  private createNoise(): AudioBufferSourceNode {
    const bufferSize = this.ctx.sampleRate * 2;
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    const node = this.ctx.createBufferSource();
    node.buffer = buffer;
    node.loop = true;
    node.start();
    return node;
  }
}
```

---

## ハプティクス実装

```tsx
// HapticProvider.tsx
'use client';
import { useHaptic } from 'use-haptic';
import { useEffect } from 'react';

export function HapticProvider({ children }: { children: React.ReactNode }) {
  const { triggerHaptic, isSupported } = useHaptic();

  // Androidフォールバック
  const vibrate = (pattern: number[]) => {
    if (isSupported) {
      triggerHaptic(); // iOS: checkbox switch
    } else if (navigator.vibrate) {
      navigator.vibrate(pattern); // Android
    }
  };

  // 心拍パターン: ドクン（長）+ 短い間隔 + ドクン（短）
  const heartbeatPattern = [100, 50, 50];

  useEffect(() => {
    // グローバルイベントリスナー
    window.addEventListener('touchstart', () => vibrate(heartbeatPattern));
  }, []);

  return <>{children}</>;
}
```

---

## PartyKit統合（オプション）

### サーバー側
```typescript
// party/touch-room.ts
import type { PartyKitServer } from 'partykit/server';

export default {
  async onConnect(connection, room) {
    connection.send(JSON.stringify({ type: 'welcome', users: room.connections.size }));
  },

  async onMessage(message, sender, room) {
    const data = JSON.parse(message as string);
    // 送信者以外に転送
    room.broadcast(message, [sender.id]);
  },
} satisfies PartyKitServer;
```

### クライアント側
```typescript
// usePartyTouch.ts
import usePartySocket from 'partysocket/react';

export function usePartyTouch(roomId: string) {
  const socket = usePartySocket({
    host: 'your-project.partykit.dev',
    room: roomId,
    onMessage(event) {
      const data = JSON.parse(event.data);
      // 他の人のタッチを処理
      if (data.type === 'touch') {
        addRemoteTouch(data.x, data.y, data.color);
      }
    },
  });

  const sendTouch = (x: number, y: number) => {
    socket.send(JSON.stringify({ type: 'touch', x, y, color: [0, 1, 1] }));
  };

  return { sendTouch };
}
```

---

## デプロイ

```bash
# Vercel推奨
npm install -g vercel
vercel

# 環境変数（PartyKit使う場合）
NEXT_PUBLIC_PARTYKIT_HOST=your-project.partykit.dev
```

### Zoom発表用セットアップ
1. Vercelデプロイ後、URLをQRコード化
2. QRコードを含むランディングページを`/app/page.tsx`に配置
3. Zoom画面共有でランディングを表示
4. 参加者がスマホでアクセス → `/touch`に遷移
5. 自分の画面で`/touch`を開いて全員のインタラクションを表示

---

## 重要な注意点

### 1. iOS Safariの制約
- Web Audio APIは**ユーザージェスチャー後**にしか起動できない
- 最初のタップで`audioContext.resume()`を呼ぶ
```typescript
document.addEventListener('touchstart', () => {
  if (audioContext.state === 'suspended') {
    audioContext.resume();
  }
}, { once: true });
```

### 2. パフォーマンス
- `requestAnimationFrame`の中で重い処理をしない
- 流体シミュレーションは別のWebGL contextで処理
- React Three FiberのuseFrameは60fps前提

### 3. Zoom画面共有時の注意
- ブラウザのデバッグコンソールは閉じる
- フルスクリーン表示
- 事前にデモ用のダミータッチデータを流すモード用意（参加者アクセス前でも動いて見える）

### 4. フォールバック
- WebGL2非対応: 静的な画像 + 説明
- ハプティクス不可: 画面フラッシュ + 音量UP
- 音声不可: 視覚のみで完結

---

## 参考リンク集

### 流体シミュレーション
- Pavel Dobryakov GitHub: https://github.com/PavelDoGreat/WebGL-Fluid-Simulation
- デモ: https://paveldogreat.github.io/WebGL-Fluid-Simulation/
- 解説: https://developer.nvidia.com/gpugems/gpugems/part-vi-beyond-triangles/chapter-38-fast-fluid-dynamics-simulation-gpu

### React Three Fiber
- 公式: https://docs.pmnd.rs/react-three-fiber
- シェーダー統合: https://docs.pmnd.rs/react-three-fiber/api/hooks#useframe

### Web Audio API
- MDN: https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API
- チュートリアル: https://github.com/pparocza/generative-music-web-audio

### ハプティクス
- use-haptic npm: https://www.npmjs.com/package/use-haptic
- iOS checkbox switch: https://webkit.org/blog/15965/

### PartyKit
- 公式: https://docs.partykit.io/
- Examples: https://github.com/partykit/partykit/tree/main/examples

---

## タイムライン（発表まで）

仮に**3日間**で開発する場合：

### Day 1（8時間）
- プロジェクトセットアップ
- Pavel流体シミュレーション移植
- タッチ → 流体反応の基本実装

### Day 2（8時間）
- ハプティクス統合
- Web Audio心拍音実装
- ヒートマップ・残像エフェクト

### Day 3（4時間）
- UI/UX調整
- モバイル最適化
- Zoom発表用ランディング作成
- リハーサル

---

## 成功の定義

### 最低限（これができればOK）
✅ スマホでアクセス可能
✅ タッチで画面が反応（流体的な動き）
✅ 振動または音でフィードバック
✅ Zoom画面共有で全員が見える

### 理想
✅ iOS/Android両対応
✅ 複数人同時アクセスで全員のタッチが見える
✅ 心拍音・吐息が触り方で変化
✅ 「一期一会の波形」保存機能

---

## コードを書き始める前のチェックリスト

- [ ] Node.js 18+ インストール済み
- [ ] Next.js 15理解している
- [ ] WebGL/GLSLの基本知識（Pavel's codeを読める程度）
- [ ] Vercelアカウント作成済み
- [ ] スマホ実機テスト環境（iOS + Android）
- [ ] Zoom画面共有テスト済み

---

以上でClaude Codeに渡す情報は揃いました。
このドキュメントを元に、段階的に実装を進めてください。
