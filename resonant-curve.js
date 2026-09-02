// ── Resonant Curve エフェクトエンジン
// シンセサイザーのサブトラクティブ・フィルター（カットオフ×レゾナンス）を画像処理に翻訳する:
// 01 CUTOFF     → ローパスフィルターの基準スケール（ぼかし半径）
// 02 RESONANCE  → CUTOFFが決めるスケール帯だけをバンドパス的に強調（DoG＋フィードバックで自己発振を再現）
// 03 WAVEFORM   → ウェーブシェイピング。階調をSカーブ（サイン波）⇄ポスタリゼーション（矩形波）で変形
// 04 LFO        → cloudNoiseベースの緩やかな空間的揺らぎ
// 05 ENVELOPE   → 画面中心→端に向かって効果が強まる空間的ADSR
// 06 BITCRUSH   → 量子化前にディザを足してから階調を落とす、ローファイサンプラーのビット深度
// 07 FLATTEN    → 強めのぼかし＋大胆な色数削減で、色面の塊を作る（熊谷守一のベタ塗り的表現）
// 08 OUTLINE    → Sobelでエッジを検出し、地の色を沈めたインク色で輪郭線を重ねる（モルフォロジー膨張で太さ、丸め＋揺らぎで有機的に）
//    └ INK TONE → OUTLINEのインクの色調（0=純粋な黒、1=地の色を沈めた色）
// 09 NIHONGA    → 色相を岩絵具的なアンカー色へ寄せ、彩度を落として和紙のようなマットな質感にする
// （2段階プレビュー処理・ノイズ関数・iOS保存はMemory Grain a520 / Clair de Luneの既存資産を移植）

const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const outputCanvas = document.getElementById('outputCanvas');
const canvasBadge = document.getElementById('canvasBadge');
const ctx = outputCanvas.getContext('2d');

const cutoffSlider = document.getElementById('cutoff');
const resonanceSlider = document.getElementById('resonance');
const waveformSlider = document.getElementById('waveform');
const lfoSlider = document.getElementById('lfo');
const envelopeSlider = document.getElementById('envelope');
const bitcrushSlider = document.getElementById('bitcrush');
const flattenSlider = document.getElementById('flatten');
const outlineSlider = document.getElementById('outline');
const inkToneSlider = document.getElementById('inkTone');
const inkHueSlider = document.getElementById('inkHue');
const nihongaSlider = document.getElementById('nihonga');
const monochromeCheckbox = document.getElementById('monochrome');

const cutoffVal = document.getElementById('cutoffVal');
const resonanceVal = document.getElementById('resonanceVal');
const waveformVal = document.getElementById('waveformVal');
const lfoVal = document.getElementById('lfoVal');
const envelopeVal = document.getElementById('envelopeVal');
const bitcrushVal = document.getElementById('bitcrushVal');
const flattenVal = document.getElementById('flattenVal');
const outlineVal = document.getElementById('outlineVal');
const inkToneVal = document.getElementById('inkToneVal');
const inkHueVal = document.getElementById('inkHueVal');
const nihongaVal = document.getElementById('nihongaVal');

const downloadBtn = document.getElementById('downloadBtn');
const resetBtn = document.getElementById('resetBtn');
const patchBtns = document.querySelectorAll('.profile-btn');

let originalImage = null;
let originalImageData = null;
let previewImageData = null;
let isDragging = false;

// ── ファイル読み込み
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith('image/')) loadFile(file);
});
fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) loadFile(file);
});

function loadFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      originalImage = img;
      setupCanvas(img);
      applyResonantCurve();
      dropZone.style.display = 'none';
      canvasBadge.style.display = 'block';
      outputCanvas.style.display = 'block';
      downloadBtn.disabled = false;
      resetBtn.disabled = false;
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function setupCanvas(img) {
  const MAX_W = 900;
  let w = img.width, h = img.height;
  if (w > MAX_W) { h = h * (MAX_W / w); w = MAX_W; }
  outputCanvas.width = w;
  outputCanvas.height = h;
  ctx.drawImage(img, 0, 0, w, h);
  originalImageData = ctx.getImageData(0, 0, w, h);

  const PREVIEW_MAX_W = 320;
  const pScale = Math.min(1, PREVIEW_MAX_W / w);
  const pw = Math.max(1, Math.round(w * pScale));
  const ph = Math.max(1, Math.round(h * pScale));
  const pCanvas = document.createElement('canvas');
  pCanvas.width = pw; pCanvas.height = ph;
  const pCtx = pCanvas.getContext('2d');
  pCtx.drawImage(img, 0, 0, pw, ph);
  previewImageData = pCtx.getImageData(0, 0, pw, ph);
}

let driftRAF = null;
function requestApply() {
  if (driftRAF) cancelAnimationFrame(driftRAF);
  driftRAF = requestAnimationFrame(() => {
    driftRAF = null;
    if (isDragging) {
      applyResonantCurve(true);
    } else {
      // フル解像度の重い処理の前に「処理中…」を一度描画してから計算に入る
      // （setTimeoutで1フレーム挟むことで、フリーズしてるように見えるのを防ぐ）
      const prevBadge = canvasBadge.textContent;
      canvasBadge.textContent = '処理中… PROCESSING';
      canvasBadge.style.display = 'block';
      setTimeout(() => {
        applyResonantCurve(false);
        canvasBadge.textContent = 'PREVIEW';
      }, 10);
    }
  });
}

// ── 決定論的な擬似ランダム／ノイズ（Memory Grain a520 / Clair de Luneより移植）
function pseudoRandom(seed) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}
function pseudoRandom2D(x, y) {
  const v = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return v - Math.floor(v);
}
function smoothNoise2D(x, y, scale) {
  const sx = x / scale, sy = y / scale;
  const x0 = Math.floor(sx), y0 = Math.floor(sy);
  const fx = sx - x0, fy = sy - y0;
  const v00 = pseudoRandom2D(x0, y0);
  const v10 = pseudoRandom2D(x0+1, y0);
  const v01 = pseudoRandom2D(x0, y0+1);
  const v11 = pseudoRandom2D(x0+1, y0+1);
  const sfx = fx*fx*(3-2*fx);
  const sfy = fy*fy*(3-2*fy);
  const top = v00 + (v10 - v00) * sfx;
  const bottom = v01 + (v11 - v01) * sfx;
  return top + (bottom - top) * sfy;
}
function cloudNoise(x, y) {
  return smoothNoise2D(x, y, 180) * 0.5
       + smoothNoise2D(x + 1000, y + 1000, 80) * 0.3
       + smoothNoise2D(x + 2000, y + 2000, 35) * 0.2;
}

// ── 簡易ボックスブラー（CUTOFF / RESONANCEのDoG生成に使用）
// ── RGB空間でのk-meansクラスタリング（FLATTENが使う色そのものを絞り込むために使用）
// パフォーマンスのため、全ピクセルではなくサンプリングした点だけで重心を求め、
// 初期重心はサンプルを輝度順に並べて等間隔に選ぶ（乱数を使わず毎回同じ結果になるように）
function kMeansColors(data, w, h, k) {
  const totalPixels = w * h;
  const sampleCount = Math.min(2000, totalPixels);
  const step = Math.max(1, Math.floor(totalPixels / sampleCount));
  const samples = [];
  for (let p = 0; p < totalPixels; p += step) {
    const i = p * 4;
    samples.push([data[i], data[i+1], data[i+2]]);
  }
  samples.sort((a, b) => (a[0]*0.299+a[1]*0.587+a[2]*0.114) - (b[0]*0.299+b[1]*0.587+b[2]*0.114));

  const centers = [];
  for (let c = 0; c < k; c++) {
    const idx = Math.min(samples.length - 1, Math.floor((c + 0.5) / k * samples.length));
    centers.push(samples[idx].slice());
  }

  const iterations = 5;
  for (let iter = 0; iter < iterations; iter++) {
    const sums = centers.map(() => [0,0,0,0]); // r,g,b,count
    for (let s = 0; s < samples.length; s++) {
      const [r,g,b] = samples[s];
      let bestIdx = 0, bestDist = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const dr = r-centers[c][0], dg = g-centers[c][1], db = b-centers[c][2];
        const dist = dr*dr + dg*dg + db*db;
        if (dist < bestDist) { bestDist = dist; bestIdx = c; }
      }
      sums[bestIdx][0] += r; sums[bestIdx][1] += g; sums[bestIdx][2] += b; sums[bestIdx][3]++;
    }
    for (let c = 0; c < centers.length; c++) {
      if (sums[c][3] > 0) {
        centers[c][0] = sums[c][0] / sums[c][3];
        centers[c][1] = sums[c][1] / sums[c][3];
        centers[c][2] = sums[c][2] / sums[c][3];
      }
    }
  }
  return centers;
}

function rgbToHsl(r, g, b) {
  r/=255; g/=255; b/=255;
  const max = Math.max(r,g,b), min = Math.min(r,g,b);
  let h=0, s=0; const l = (max+min)/2;
  const d = max-min;
  if (d > 0.0001) {
    s = l > 0.5 ? d/(2-max-min) : d/(max+min);
    if (max===r) h = ((g-b)/d + (g<b?6:0));
    else if (max===g) h = (b-r)/d + 2;
    else h = (r-g)/d + 4;
    h *= 60;
  }
  return [h, s, l];
}
function hslToRgbArr(h, s, l) {
  h = ((h%360)+360)%360;
  const c = (1-Math.abs(2*l-1))*s;
  const x = c*(1-Math.abs((h/60)%2-1));
  const m = l - c/2;
  let r=0,g=0,b=0;
  if (h<60){r=c;g=x;b=0;} else if (h<120){r=x;g=c;b=0;}
  else if (h<180){r=0;g=c;b=x;} else if (h<240){r=0;g=x;b=c;}
  else if (h<300){r=x;g=0;b=c;} else {r=c;g=0;b=x;}
  return [(r+m)*255, (g+m)*255, (b+m)*255];
}

// ── スライディングウィンドウ最大値フィルタ（モルフォロジー膨張。OUTLINEの線を太らせるのに使用）
// 単チャンネルのFloat32Array/Uint8Arrayに対して、半径によらず高速なO(1)償却の単調deque方式
function maxFilter(data, w, h, radius) {
  const r = Math.max(1, Math.round(radius));
  const temp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const deque = new Int32Array(Math.max(w, h) + 1);

  for (let y = 0; y < h; y++) {
    const row = y * w;
    let head = 0, tail = 0; // [head, tail)
    for (let x = 0; x < w + r; x++) {
      if (x < w) {
        const v = data[row + x];
        while (tail > head && data[row + deque[tail-1]] <= v) tail--;
        deque[tail++] = x;
      }
      const outX = x - r;
      if (outX >= 0 && outX < w) {
        while (deque[head] < outX - r) head++;
        temp[row + outX] = data[row + deque[head]];
      }
    }
  }
  for (let x = 0; x < w; x++) {
    let head = 0, tail = 0;
    for (let y = 0; y < h + r; y++) {
      if (y < h) {
        const v = temp[y*w + x];
        while (tail > head && temp[deque[tail-1]*w + x] <= v) tail--;
        deque[tail++] = y;
      }
      const outY = y - r;
      if (outY >= 0 && outY < h) {
        while (deque[head] < outY - r) head++;
        out[outY*w + x] = temp[deque[head]*w + x];
      }
    }
  }
  return out;
}

function boxBlur(data, w, h, radius) {
  if (radius < 1) return data.slice();
  const r = Math.max(1, Math.round(radius));
  const temp = new Float32Array(data.length);
  const out = new Uint8ClampedArray(data.length);

  // ── 横方向：スライディングウィンドウ（半径によらずO(w)/行）
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    let sr=0, sg=0, sb=0, sa=0;
    for (let k = -r; k <= r; k++) {
      const sx = k < 0 ? 0 : (k >= w ? w - 1 : k);
      const i = row + sx*4;
      sr += data[i]; sg += data[i+1]; sb += data[i+2]; sa += data[i+3];
    }
    const count = 2*r + 1;
    temp[row] = sr/count; temp[row+1] = sg/count; temp[row+2] = sb/count; temp[row+3] = sa/count;
    for (let x = 1; x < w; x++) {
      const addX = (x+r) >= w ? w-1 : x+r;
      const remX = (x-1-r) < 0 ? 0 : x-1-r;
      const ai = row + addX*4, ri = row + remX*4;
      sr += data[ai]   - data[ri];
      sg += data[ai+1] - data[ri+1];
      sb += data[ai+2] - data[ri+2];
      sa += data[ai+3] - data[ri+3];
      const oi = row + x*4;
      temp[oi] = sr/count; temp[oi+1] = sg/count; temp[oi+2] = sb/count; temp[oi+3] = sa/count;
    }
  }

  // ── 縦方向：同じくスライディングウィンドウ（半径によらずO(h)/列）
  for (let x = 0; x < w; x++) {
    let sr=0, sg=0, sb=0, sa=0;
    for (let k = -r; k <= r; k++) {
      const sy = k < 0 ? 0 : (k >= h ? h - 1 : k);
      const i = (sy*w+x)*4;
      sr += temp[i]; sg += temp[i+1]; sb += temp[i+2]; sa += temp[i+3];
    }
    const count = 2*r + 1;
    let oi = x*4;
    out[oi] = sr/count; out[oi+1] = sg/count; out[oi+2] = sb/count; out[oi+3] = sa/count;
    for (let y = 1; y < h; y++) {
      const addY = (y+r) >= h ? h-1 : y+r;
      const remY = (y-1-r) < 0 ? 0 : y-1-r;
      const ai = (addY*w+x)*4, ri = (remY*w+x)*4;
      sr += temp[ai]   - temp[ri];
      sg += temp[ai+1] - temp[ri+1];
      sb += temp[ai+2] - temp[ri+2];
      sa += temp[ai+3] - temp[ri+3];
      oi = (y*w+x)*4;
      out[oi] = sr/count; out[oi+1] = sg/count; out[oi+2] = sb/count; out[oi+3] = sa/count;
    }
  }
  return out;
}

function applyResonantCurve(preview) {
  if (!originalImageData) return;

  const useData = (preview && previewImageData) ? previewImageData : originalImageData;
  const w = useData.width;
  const h = useData.height;
  const radiusScale = preview ? (w / outputCanvas.width) : 1;

  const cutoff = parseInt(cutoffSlider.value) / 100;
  const resonance = parseInt(resonanceSlider.value) / 100;
  const waveform = parseInt(waveformSlider.value) / 100;
  const lfo = parseInt(lfoSlider.value) / 100;
  const envelope = parseInt(envelopeSlider.value) / 100;
  const bitcrush = parseInt(bitcrushSlider.value) / 100;
  const flatten = parseInt(flattenSlider.value) / 100;
  const outline = parseInt(outlineSlider.value) / 100;
  const inkTone = parseInt(inkToneSlider.value) / 100;
  const inkHue = parseInt(inkHueSlider.value) / 100;
  const nihonga = parseInt(nihongaSlider.value) / 100;
  const mono = monochromeCheckbox.checked;

  const src = useData.data;

  // ── CUTOFF：ローパスの基準スケール。カットオフが低いほど大きくぼかす（低い周波数しか通さない）
  const baseRadius = (2 + (1 - cutoff) * 42) * Math.max(radiusScale, 0.35);

  // ── ENVELOPE：画面中心→端に向かって効果が強まる空間マスク。
  //    綺麗な同心円のままだと不自然なので、Clair de LuneのWOBBLEと同じcloudNoiseで輪郭を崩し、
  //    smoothstepで滑らかに繋げる（有機的な"揺らぎのある包絡"にする）
  //    ※cloudNoiseは全ピクセル計算だと重いので、(サイズ, envelope)が前回と同じならキャッシュを再利用する。
  //      ENVELOPE=0のときはそもそも効果が無いので、重いノイズ計算自体をスキップする。
  const cx = w / 2, cy = h / 2;
  const maxDist = Math.sqrt(cx*cx + cy*cy);
  let envMap, envCombined;
  const envCacheKey = `${w}x${h}:${envelope.toFixed(3)}`;
  if (applyResonantCurve._envCache && applyResonantCurve._envCache.key === envCacheKey) {
    envMap = applyResonantCurve._envCache.envMap;
    envCombined = applyResonantCurve._envCache.envCombined;
  } else {
    envMap = new Float32Array(w * h);
    envCombined = new Float32Array(w * h); // 0(中心寄り)〜1(端寄り)の有機的な素の値。WAVEFORMのブレンドにも共用する
    if (envelope > 0.01) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const d = Math.sqrt((x-cx)*(x-cx) + (y-cy)*(y-cy)) / maxDist; // 0(中心)〜1(端)
          const smoothD = d * d * (3 - 2 * d); // 滑らかなイージング
          const organic = cloudNoise(x, y); // 0〜1のなだらかな有機的ノイズ
          const combined = Math.max(0, Math.min(1, smoothD + (organic - 0.5) * 0.5));
          envCombined[y*w+x] = combined;
          envMap[y*w+x] = 1 + envelope * combined * 2.2; // 中心はほぼ1倍、端は最大3倍強調（輪郭は有機的に崩す）
        }
      }
    } else {
      envMap.fill(1); // ENVELOPE=0：効果なしなので1で埋めるだけ（cloudNoise計算は不要）
      envCombined.fill(0);
    }
    applyResonantCurve._envCache = { key: envCacheKey, envMap, envCombined };
  }

  // ── RESONANCE：CUTOFFが決めるスケール帯だけをバンドパス的に強調し、
  //    フィードバックを重ねることで高レゾナンス時に自己発振（リング状の模様）を再現する
  //    ※ENVELOPEはフィードバックの外側で1回だけ適用する（ループ内で毎回掛けると複利的に増幅し、斑点状に荒れるため）
  let boosted = new Uint8ClampedArray(src);
  if (resonance > 0.01) {
    const iterations = 1 + Math.round(resonance * 2); // 1〜3回のフィードバック
    for (let iter = 0; iter < iterations; iter++) {
      const blurNarrow = boxBlur(boosted, w, h, baseRadius * 0.7);
      const blurWide = boxBlur(boosted, w, h, baseRadius * 1.3);
      const next = new Uint8ClampedArray(boosted.length);
      const gain = resonance * resonance * 2.4;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y*w+x)*4;
          const bandR = (blurNarrow[i]   - blurWide[i])   * gain;
          const bandG = (blurNarrow[i+1] - blurWide[i+1]) * gain;
          const bandB = (blurNarrow[i+2] - blurWide[i+2]) * gain;
          next[i]   = boosted[i]   + bandR;
          next[i+1] = boosted[i+1] + bandG;
          next[i+2] = boosted[i+2] + bandB;
          next[i+3] = boosted[i+3];
        }
      }
      boosted = next;
    }
    // フィードバック後にできた差分（＝共鳴で足された成分）だけにENVELOPEを1回だけ適用
    const withEnv = new Uint8ClampedArray(boosted.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y*w+x)*4;
        const envMult = envMap[y*w+x];
        withEnv[i]   = src[i]   + (boosted[i]   - src[i])   * envMult;
        withEnv[i+1] = src[i+1] + (boosted[i+1] - src[i+1]) * envMult;
        withEnv[i+2] = src[i+2] + (boosted[i+2] - src[i+2]) * envMult;
        withEnv[i+3] = boosted[i+3];
      }
    }
    boosted = withEnv;
  } else if (cutoff < 0.999) {
    // レゾナンスなしでもCUTOFFは効く：単純なローパス（ブレンド）
    const blurred = boxBlur(boosted, w, h, baseRadius);
    const next = new Uint8ClampedArray(boosted.length);
    const mixAmount = (1 - cutoff); // カットオフが低いほどぼかしを強く反映
    for (let i = 0; i < boosted.length; i += 4) {
      next[i]   = boosted[i]   * (1-mixAmount) + blurred[i]   * mixAmount;
      next[i+1] = boosted[i+1] * (1-mixAmount) + blurred[i+1] * mixAmount;
      next[i+2] = boosted[i+2] * (1-mixAmount) + blurred[i+2] * mixAmount;
      next[i+3] = boosted[i+3];
    }
    boosted = next;
  }

  let out = boosted;

  // ── WAVEFORM：ウェーブシェイピング（階調の変換）。サイン波的な滑らかなSカーブ ⇄ 矩形波的なポスタリゼーション
  //    模様を足すのではなく、明暗の変換カーブそのものを変形するので、迷彩や縞にはならない
  if (waveform > 0.01) {
    const posterLevels = 3; // 矩形波側の階調数（少ないほどパキッとする）
    const softK = 3.2; // サイン波側のSカーブの強さ
    const next = new Uint8ClampedArray(out.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y*w+x)*4;
        const combined = envCombined[y*w+x];
        // ENVELOPE=0のときは全面に均一適用、上げるほど中心は控えめ・端は強めに（RESONANCE/LFOと同じ有機的な形状）
        const effectAmt = Math.max(0, Math.min(1, 1 - envelope * (1 - combined) * 0.9));

        for (let c = 0; c < 3; c++) {
          const t = out[i+c] / 255;
          const soft = 0.5 + 0.5 * Math.tanh((t - 0.5) * softK * 2);
          const poster = Math.round(t * posterLevels) / posterLevels;
          const shaped = soft * (1 - waveform) + poster * waveform;
          next[i+c] = (t * 255) * (1 - effectAmt) + (shaped * 255) * effectAmt;
        }
        next[i+3] = out[i+3];
      }
    }
    out = next;
  }

  // ── LFO：cloudNoiseベースの緩やかな空間的揺らぎ
  if (lfo > 0.01) {
    const next = new Uint8ClampedArray(out.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y*w+x)*4;
        const envMult = envMap[y*w+x];
        const wob = cloudNoise(x, y) - 0.5;
        const delta = wob * 2 * 26 * lfo * envMult;
        next[i]   = out[i]   + delta;
        next[i+1] = out[i+1] + delta;
        next[i+2] = out[i+2] + delta;
        next[i+3] = out[i+3];
      }
    }
    out = next;
  }

  // ── FLATTEN：強めのぼかしで細部を馴染ませてから、画面全体の色をクラスタリングして
  //    実際に使う色の種類そのものを絞り込む（チャンネル別の量子化だと理論上27色まで残ってしまうため、
  //    RGB空間でのk-meansクラスタリングに変更。右に振り切ると本当に2〜3色のポスターのような絵になる）
  if (flatten > 0.01) {
    const flattenRadius = flatten * 14 * Math.max(radiusScale, 0.35);
    const blurred = boxBlur(out, w, h, flattenRadius);
    const k = Math.max(2, Math.round(20 - flatten * 18)); // 20色（控えめ）〜2色（究極にシンプル）
    const centers = kMeansColors(blurred, w, h, k);
    const next = new Uint8ClampedArray(out.length);
    for (let i = 0; i < blurred.length; i += 4) {
      const r = blurred[i], g = blurred[i+1], b = blurred[i+2];
      let bestIdx = 0, bestDist = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const dr = r-centers[c][0], dg = g-centers[c][1], db = b-centers[c][2];
        const dist = dr*dr + dg*dg + db*db;
        if (dist < bestDist) { bestDist = dist; bestIdx = c; }
      }
      next[i] = centers[bestIdx][0]; next[i+1] = centers[bestIdx][1]; next[i+2] = centers[bestIdx][2];
      next[i+3] = out[i+3];
    }
    // 色面の境界はシャープなまま残す（滑らかさはOUTLINE側のにじみだけで表現する）
    out = next;
  }

  // ── OUTLINE：Sobelでエッジを検出し、その場の色を沈めた「インク色」で輪郭線として重ねる
  //    太らせ方はモルフォロジー膨張で輪郭のキレを保ちつつ、太さに応じて角を丸め、
  //    cloudNoiseでごくわずかに輪郭を揺らして、人が描いたような有機的な線にする
  if (outline > 0.01) {
    const edgeField = new Float32Array(w * h);
    const getLum = (x, y) => {
      const xx = x < 0 ? 0 : (x >= w ? w-1 : x);
      const yy = y < 0 ? 0 : (y >= h ? h-1 : y);
      const i = (yy*w+xx)*4;
      return out[i]*0.299 + out[i+1]*0.587 + out[i+2]*0.114;
    };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const gx = -getLum(x-1,y-1) - 2*getLum(x-1,y) - getLum(x-1,y+1)
                   +getLum(x+1,y-1) + 2*getLum(x+1,y) + getLum(x+1,y+1);
        const gy = -getLum(x-1,y-1) - 2*getLum(x,y-1) - getLum(x+1,y-1)
                   +getLum(x-1,y+1) + 2*getLum(x,y+1) + getLum(x+1,y+1);
        const mag = Math.sqrt(gx*gx + gy*gy) / 1020;
        edgeField[y*w+x] = Math.max(0, Math.min(1, mag * 2.8)) * 255;
      }
    }
    // 太さ：モルフォロジー膨張（正方形寄りの角ばった形になる）
    const dilateRadius = 1 + outline * 10 * Math.max(radiusScale, 0.35);
    const dilated = maxFilter(edgeField, w, h, dilateRadius);
    // 角の丸め：太さに比例してアンチエイリアス半径を大きくし、機械的な角ばりを丸める
    const roundRadius = Math.min(4.5, Math.max(0.6, dilateRadius * 0.3)) * Math.max(radiusScale, 0.35);
    const aaPack = new Uint8ClampedArray(w * h * 4);
    for (let p = 0; p < w*h; p++) { const v = dilated[p]; aaPack[p*4]=v; aaPack[p*4+1]=v; aaPack[p*4+2]=v; aaPack[p*4+3]=255; }
    const aa = boxBlur(aaPack, w, h, roundRadius);

    const next = new Uint8ClampedArray(out);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y*w+x;
        // 有機的な揺らぎ：輪郭の"太さ"自体をcloudNoiseでほんの少し波打たせ、機械的な均一さを崩す
        const jitter = (cloudNoise(x, y) - 0.5) * 0.22 * outline;
        const thickEdge = Math.max(0, Math.min(1, aa[p*4] / 255 + jitter));
        if (thickEdge < 0.04) continue;

        const i = p*4;
        // INK TONE：0で純粋な黒インク、1（既定に近い）でその場の色を沈めたインク
        let inkR = out[i]   * 0.32 * inkTone;
        let inkG = out[i+1] * 0.32 * inkTone;
        let inkB = out[i+2] * 0.32 * inkTone;
        // INK HUE：インクの色相を回転させる（地の色ベースを保ちつつ色みだけ変える）
        if (inkHue > 0.001) {
          const [ih, is, il] = rgbToHsl(inkR, inkG, inkB);
          const [nr, ng, nb] = hslToRgbArr(ih + inkHue * 360, is, il);
          inkR = nr; inkG = ng; inkB = nb;
        }
        const blend = Math.min(1, thickEdge * (0.7 + outline * 0.9));
        next[i]   = out[i]   * (1-blend) + inkR * blend;
        next[i+1] = out[i+1] * (1-blend) + inkG * blend;
        next[i+2] = out[i+2] * (1-blend) + inkB * blend;
      }
    }
    out = next;
  }

  // ── NIHONGA：色相を日本画の岩絵具を思わせるアンカー（朱・黄土・緑青・藍・鈍い紫）へ寄せ、
  //    彩度を少し落として和紙のようなマットな質感に。インクの線も同じ色調に馴染む
  if (nihonga > 0.01) {
    const anchors = [10, 40, 150, 210, 320]; // 朱・黄土・緑青・藍・鈍い紫
    const next = new Uint8ClampedArray(out.length);
    for (let i = 0; i < out.length; i += 4) {
      let [h, s, l] = rgbToHsl(out[i], out[i+1], out[i+2]);
      let nearest = anchors[0], bestDiff = 360;
      for (const a of anchors) {
        let diff = Math.abs(h - a);
        if (diff > 180) diff = 360 - diff;
        if (diff < bestDiff) { bestDiff = diff; nearest = a; }
      }
      let hueDiff = nearest - h;
      if (hueDiff > 180) hueDiff -= 360;
      if (hueDiff < -180) hueDiff += 360;
      h = h + hueDiff * (nihonga * 0.7);
      s = s * (1 - nihonga * 0.25) + nihonga * 0.12;
      l = l * (1 - nihonga * 0.12) + nihonga * 0.08;
      const [r,g,b] = hslToRgbArr(h, Math.max(0,Math.min(1,s)), Math.max(0,Math.min(1,l)));
      // 和紙のような、わずかな暖色シフト
      next[i]   = r + nihonga * 6;
      next[i+1] = g;
      next[i+2] = b - nihonga * 6;
      next[i+3] = out[i+3];
    }
    out = next;
  }

  // ── BITCRUSH：量子化前に小さなディザを足してから階調を落とす（ローファイサンプラーのビットクラッシュ）
  if (bitcrush > 0.01) {
    const levels = Math.max(4, Math.round(255 - bitcrush * 251)); // 大きいほど粗い量子化幅
    const step = 255 / levels;
    const next = new Uint8ClampedArray(out.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y*w+x)*4;
        const dither = (pseudoRandom2D(x + 8000, y + 8000) - 0.5) * step * 0.9;
        next[i]   = Math.round((out[i]   + dither) / step) * step;
        next[i+1] = Math.round((out[i+1] + dither) / step) * step;
        next[i+2] = Math.round((out[i+2] + dither) / step) * step;
        next[i+3] = out[i+3];
      }
    }
    out = next;
  }

  if (mono) {
    const mono2 = new Uint8ClampedArray(out.length);
    for (let i = 0; i < out.length; i += 4) {
      const gray = out[i]*0.299 + out[i+1]*0.587 + out[i+2]*0.114;
      mono2[i] = mono2[i+1] = mono2[i+2] = gray;
      mono2[i+3] = out[i+3];
    }
    out = mono2;
  }

  const resultData = new ImageData(out, w, h);

  if (preview && previewImageData) {
    let tempCanvas = applyResonantCurve._tempCanvas;
    if (!tempCanvas) {
      tempCanvas = document.createElement('canvas');
      applyResonantCurve._tempCanvas = tempCanvas;
    }
    tempCanvas.width = w; tempCanvas.height = h;
    tempCanvas.getContext('2d').putImageData(resultData, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(tempCanvas, 0, 0, w, h, 0, 0, outputCanvas.width, outputCanvas.height);
  } else {
    ctx.putImageData(resultData, 0, 0);
  }
}

// ── UIイベント
const allSliders = [cutoffSlider, resonanceSlider, waveformSlider, lfoSlider, envelopeSlider, bitcrushSlider, flattenSlider, outlineSlider, nihongaSlider, inkToneSlider, inkHueSlider];

allSliders.forEach(slider => {
  slider.addEventListener('pointerdown', () => { isDragging = true; });
  slider.addEventListener('touchstart', () => { isDragging = true; }, { passive: true });
});
function endDrag() {
  if (!isDragging) return;
  isDragging = false;
  requestApply();
}
allSliders.forEach(slider => {
  slider.addEventListener('pointerup', endDrag);
  slider.addEventListener('touchend', endDrag);
  slider.addEventListener('change', endDrag);
});
window.addEventListener('pointerup', () => { if (isDragging) endDrag(); });
window.addEventListener('touchend', () => { if (isDragging) endDrag(); });

cutoffSlider.addEventListener('input', () => { cutoffVal.textContent = cutoffSlider.value + '%'; clearPatchActive(); requestApply(); });
resonanceSlider.addEventListener('input', () => { resonanceVal.textContent = resonanceSlider.value + '%'; clearPatchActive(); requestApply(); });
waveformSlider.addEventListener('input', () => { waveformVal.textContent = waveformSlider.value + '%'; clearPatchActive(); requestApply(); });
lfoSlider.addEventListener('input', () => { lfoVal.textContent = lfoSlider.value + '%'; clearPatchActive(); requestApply(); });
envelopeSlider.addEventListener('input', () => { envelopeVal.textContent = envelopeSlider.value + '%'; clearPatchActive(); requestApply(); });
bitcrushSlider.addEventListener('input', () => { bitcrushVal.textContent = bitcrushSlider.value + '%'; clearPatchActive(); requestApply(); });
flattenSlider.addEventListener('input', () => { flattenVal.textContent = flattenSlider.value + '%'; clearPatchActive(); requestApply(); });
outlineSlider.addEventListener('input', () => { outlineVal.textContent = outlineSlider.value + '%'; clearPatchActive(); requestApply(); });
inkToneSlider.addEventListener('input', () => { inkToneVal.textContent = inkToneSlider.value + '%'; clearPatchActive(); requestApply(); });
inkHueSlider.addEventListener('input', () => { inkHueVal.textContent = Math.round((parseInt(inkHueSlider.value)/100)*360) + '°'; clearPatchActive(); requestApply(); });
nihongaSlider.addEventListener('input', () => { nihongaVal.textContent = nihongaSlider.value + '%'; clearPatchActive(); requestApply(); });
monochromeCheckbox.addEventListener('change', () => applyResonantCurve());

// ── Patch プリセット
const PATCH_PROFILES = {
  init:  { cutoff: 100, resonance: 0,  waveform: 0,  lfo: 0,  envelope: 0,  bitcrush: 0,  flatten: 0,  outline: 0,  nihonga: 0,  inkTone: 100, inkHue: 0 }, // 初期化（無加工）
  rec:   { cutoff: 58,  resonance: 22, waveform: 12, lfo: 18, envelope: 22, bitcrush: 0,  flatten: 0,  outline: 0,  nihonga: 0,  inkTone: 100, inkHue: 0 }, // Aurora：ほのかなグローと揺らぎ
  acid:  { cutoff: 35,  resonance: 80, waveform: 70, lfo: 15, envelope: 40, bitcrush: 35, flatten: 0,  outline: 0,  nihonga: 0,  inkTone: 100, inkHue: 0 }, // うねる自己発振
  abst:  { cutoff: 50,  resonance: 10, waveform: 0,  lfo: 5,  envelope: 20, bitcrush: 0,  flatten: 65, outline: 55, nihonga: 40, inkTone: 60,  inkHue: 0 }, // 抽象画：ベタ塗り＋太い輪郭線＋和の色調
};

patchBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const p = PATCH_PROFILES[btn.dataset.patch];
    if (!p) return;
    cutoffSlider.value = p.cutoff; cutoffVal.textContent = p.cutoff + '%';
    resonanceSlider.value = p.resonance; resonanceVal.textContent = p.resonance + '%';
    waveformSlider.value = p.waveform; waveformVal.textContent = p.waveform + '%';
    lfoSlider.value = p.lfo; lfoVal.textContent = p.lfo + '%';
    envelopeSlider.value = p.envelope; envelopeVal.textContent = p.envelope + '%';
    bitcrushSlider.value = p.bitcrush; bitcrushVal.textContent = p.bitcrush + '%';
    flattenSlider.value = p.flatten; flattenVal.textContent = p.flatten + '%';
    outlineSlider.value = p.outline; outlineVal.textContent = p.outline + '%';
    nihongaSlider.value = p.nihonga; nihongaVal.textContent = p.nihonga + '%';
    inkToneSlider.value = p.inkTone; inkToneVal.textContent = p.inkTone + '%';
    inkHueSlider.value = p.inkHue; inkHueVal.textContent = Math.round((p.inkHue/100)*360) + '°';
    if (btn.dataset.patch === 'init') monochromeCheckbox.checked = false; // 初期化は本当に無加工に戻す
    patchBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    requestApply();
  });
});

function clearPatchActive() { patchBtns.forEach(b => b.classList.remove('active')); }

// ── 保存（iOS対応：オーバーレイ方式。Memory Grain a520 / Clair de Luneより移植）
downloadBtn.addEventListener('click', () => {
  try {
    const dataUrl = outputCanvas.toDataURL('image/png');
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
                  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    if (isIOS) {
      showSaveOverlay(dataUrl);
    } else {
      const link = document.createElement('a');
      link.download = 'resonant-curve.png';
      link.href = dataUrl;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  } catch (err) {
    console.error('PNG保存に失敗しました:', err);
    alert('画像の保存に失敗しました。ブラウザを再読み込みしてもう一度お試しください。');
  }
});

function showSaveOverlay(dataUrl) {
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 9999;
    background: rgba(10,10,10,0.96);
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    padding: 20px; box-sizing: border-box;
  `;
  const img = document.createElement('img');
  img.src = dataUrl;
  img.style.cssText = 'max-width: 100%; max-height: 75vh; border-radius: 2px;';

  const hint = document.createElement('p');
  hint.innerHTML = '画像を長押しして「写真に保存」を選んでください<br><span style="color:#888; font-size:11px;">Press and hold the image, then tap "Save to Photos"</span>';
  hint.style.cssText = 'color: #ccc; font-family: sans-serif; font-size: 13px; margin-top: 16px; text-align: center; line-height: 1.6;';

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '閉じる / Close';
  closeBtn.style.cssText = `
    margin-top: 20px; padding: 10px 24px;
    background: transparent; color: white;
    border: 1px solid #666; border-radius: 2px;
    font-family: sans-serif; font-size: 13px; cursor: pointer;
  `;
  closeBtn.addEventListener('click', () => overlay.remove());

  overlay.appendChild(img);
  overlay.appendChild(hint);
  overlay.appendChild(closeBtn);
  document.body.appendChild(overlay);
}

resetBtn.addEventListener('click', () => {
  originalImage = null;
  originalImageData = null;
  outputCanvas.style.display = 'none';
  canvasBadge.style.display = 'none';
  dropZone.style.display = 'flex';
  downloadBtn.disabled = true;
  resetBtn.disabled = true;
  fileInput.value = '';
});
