import React, { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from 'react';
import {
  Play, RotateCcw, Copy, AlertTriangle, MousePointer2, Upload, Check,
  Pause, Crosshair, Trophy, Info, ChevronRight, Gamepad2, FileText, Target,
} from 'lucide-react';

/* ============================================================================
 * SENSITIVITY FINDER v2 — fiel ao CS2 / Valorant
 * ----------------------------------------------------------------------------
 * Diferença central em relação à v1: a mira NÃO se move pela tela. A mira
 * fica fixa no centro da tela e o MUNDO gira — exatamente como um FPS de
 * verdade. Movimento do mouse vira rotação de câmera (yaw/pitch); a posição
 * de cada alvo na tela é o resultado de uma projeção em perspectiva a partir
 * de coordenadas angulares de mundo. Ver a seção "MOTOR DE MIRA" abaixo.
 * ==========================================================================*/

/* ----------------------------------------------------------------------------
 * CONSTANTES — jogos, resolução, alvos, pontuação, benchmarks
 * --------------------------------------------------------------------------*/

// m_yaw/m_pitch padrão de cada jogo. É o que converte "contagens de mouse ×
// sensibilidade" em graus de rotação — ver seção 1.2 do motor de mira.
const GAME_PRESETS = {
  cs2: { label: 'CS2', mYaw: 0.022, comfortRange: [0.6, 2.5] },
  valorant: { label: 'Valorant', mYaw: 0.07, comfortRange: [0.15, 0.9] },
};

const RESOLUTIONS = [
  { label: '1024×768 (4:3)', w: 1024, h: 768 },
  { label: '1280×960 (4:3)', w: 1280, h: 960 },
  { label: '1280×1024 (5:4)', w: 1280, h: 1024 },
  { label: '1680×1050 (16:10)', w: 1680, h: 1050 },
  { label: '1920×1080 (16:9)', w: 1920, h: 1080 },
  { label: '2560×1440 (16:9)', w: 2560, h: 1440 },
  { label: '3440×1440 (21:9)', w: 3440, h: 1440 },
];
const DEFAULT_RESOLUTION_IDX = 4; // 1920×1080

const DISPLAY_MODES = [
  { key: 'native', label: 'Nativo' },
  { key: 'stretched43', label: '4:3 esticado' },
  { key: 'blackbars43', label: '4:3 com barras pretas' },
];

const ROUND_COUNT = 10;
const ROUND_DURATION_SEC = 40; // ⚙️
const ROUND_DURATION_MS = ROUND_DURATION_SEC * 1000;
const COUNTDOWN_SEC = 3;
const MIN_ROUNDS_TO_FINISH_EARLY = 3;

const TARGET_SPAWN_INTERVAL_MS = 1500; // ⚙️
const TARGET_LIFETIME_MS = 3000; // ⚙️
const TARGET_MAX_WRONG_HITS = 2;
const TARGET_MIN_RADIUS_PX = 8; // piso de clicabilidade em telas pequenas

// Modelagem de alvos em espaço de mundo (não em pixels) — ver seção 3.1
const HEAD_WIDTH_M = 0.20; // ⚙️ largura de referência da "cabeça"
const DIST_MIN_M = 5;
const DIST_MAX_M = 30;
const DIST_COMMON_MIN_M = 8;
const DIST_COMMON_MAX_M = 18;
const BOX_HALF_YAW_DEG = 20; // ⚙️
const BOX_HALF_PITCH_DEG = 12; // ⚙️
const CULL_MARGIN_DEG = 5; // margem além do hFOV/2 antes de descartar o alvo
const NEAR_MISS_RADIUS_MULT = 2.5;

const CALIBRATION_MS = 1200;

const NEON_COLORS = ['#22d3ee', '#f472e0', '#a3e635', '#fb923c', '#facc15', '#c084fc'];

const FEEDBACK_OPTIONS = [
  { key: 'muito_lenta', label: 'Muito lenta' },
  { key: 'lenta', label: 'Lenta' },
  { key: 'boa', label: 'Boa' },
  { key: 'rapida', label: 'Rápida' },
  { key: 'muito_rapida', label: 'Muito rápida' },
];

const FATOR_BASE = {
  muito_lenta: 1.20,
  lenta: 1.09,
  boa: 1.00,
  rapida: 0.92,
  muito_rapida: 0.83,
};

const SENS_MIN_ABSOLUTE = 0.05;

// Referências de tempo de reação — apresentadas como curiosidade, nunca como
// veredito (ver seção 4). Editáveis aqui, nomeadas.
const BENCHMARK_MS = {
  casual: 600,
  intermediario: 480,
  avancado: 380,
  profissional: 300,
};
const REFERENCIA_PRINCIPAL_MS = 480;

/* ----------------------------------------------------------------------------
 * MATEMÁTICA — ângulos e projeção (o motor de mira)
 * --------------------------------------------------------------------------*/

function degToRad(d) { return (d * Math.PI) / 180; }
function radToDeg(r) { return (r * 180) / Math.PI; }
function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }
function round3(v) { return Math.round(v * 1000) / 1000; }

// Normaliza um ângulo (graus) para o intervalo [-180, 180] — necessário para
// achar a menor rotação entre a câmera e um alvo (yaw "dá a volta").
function normalizeAngleSigned(a) {
  return ((a + 180) % 360 + 360) % 360 - 180;
}

// eDPI e cm/360 — mesma lógica da v1 (ver comentário completo em calcCm360).
function calcEDPI(dpi, sens) { return dpi * sens; }
function calcCm360(dpi, sens, mYaw) { return (2.54 * 360) / (dpi * sens * mYaw); }

// FOV horizontal a partir da proporção de tela, modelo "Hor+" (o mesmo da
// Source engine): o FOV vertical fica fixo e o horizontal cresce com a
// largura relativa da tela. Base: 90° em 4:3. É por isso que uma tela mais
// larga (21:9) tem hFOV maior que uma 4:3, mesmo com o mesmo FOV "declarado"
// — e é por isso que cm/360 (não eDPI, não pixels) é o que realmente não
// muda com a resolução.
function calcHFOVDeg(aspect) {
  const base43 = 4 / 3;
  return 2 * radToDeg(Math.atan(Math.tan(degToRad(45)) * (aspect / base43)));
}

// Parâmetros de projeção para o modo de tela escolhido.
//  - nativo: hFOV vem da PROPORÇÃO DA RESOLUÇÃO ESCOLHIDA (não da forma real
//    da janela do navegador) — é a única forma de simular fielmente uma
//    resolução diferente da tela atual.
//  - 4:3 esticado: o jogo renderiza com hFOV de 4:3 (90°) numa área virtual
//    do tamanho de uma tela 4:3 com a mesma altura, e o monitor ESTICA esse
//    resultado horizontalmente até preencher a largura real — reproduzimos
//    isso multiplicando o deslocamento X pelo fator de esticamento.
//  - 4:3 com barras pretas: mesmo hFOV de 90°, mas sem esticar — a área 4:3
//    fica centralizada, com barras pretas nas laterais.
function computeProjectionParams(mode, aspect, screenW, screenH) {
  if (mode === 'stretched43' || mode === 'blackbars43') {
    const hFOV = calcHFOVDeg(4 / 3);
    const virtualW = screenH * (4 / 3);
    const focal = (virtualW / 2) / Math.tan(degToRad(hFOV / 2));
    if (mode === 'stretched43') {
      const stretchX = virtualW > 0 ? screenW / virtualW : 1;
      return { hFOV, focal, stretchX, barsPx: 0 };
    }
    const barsPx = Math.max(0, (screenW - virtualW) / 2);
    return { hFOV, focal, stretchX: 1, barsPx };
  }
  const hFOV = calcHFOVDeg(aspect);
  const focal = (screenW / 2) / Math.tan(degToRad(hFOV / 2));
  return { hFOV, focal, stretchX: 1, barsPx: 0 };
}

// Distância sorteada por alvo, favorecendo a faixa de duelo mais comum
// (8–18 m) mas permitindo ocasionalmente a faixa completa (5–30 m) — ver 3.1.
function sampleDistanceM() {
  if (Math.random() < 0.7) return DIST_COMMON_MIN_M + Math.random() * (DIST_COMMON_MAX_M - DIST_COMMON_MIN_M);
  return DIST_MIN_M + Math.random() * (DIST_MAX_M - DIST_MIN_M);
}

// `requestPointerLock()` moderno retorna uma Promise que rejeita em caso de
// falha (elemento em iframe sem permissão, opção não suportada, etc). A
// falha "de verdade" continua sendo tratada pelo evento 'pointerlockerror';
// esta função só evita o "Uncaught (in promise)" no console e tenta um
// fallback sem raw input quando `wantRaw` falha. Retorna se o raw input foi
// de fato solicitado com sucesso.
async function requestPointerLockSafe(el, wantRaw) {
  if (!el) return false;
  if (wantRaw) {
    try {
      const p = el.requestPointerLock({ unadjustedMovement: true });
      if (p && typeof p.then === 'function') await p;
      return true;
    } catch {
      // cai para o fallback abaixo
    }
  }
  try {
    const p2 = el.requestPointerLock();
    if (p2 && typeof p2.then === 'function') await p2.catch(() => {});
  } catch {
    // o evento 'pointerlockerror' cuida da UI de erro
  }
  return false;
}

/* ----------------------------------------------------------------------------
 * MATEMÁTICA — estatística, score composto e zonas de precisão radial
 * --------------------------------------------------------------------------*/

function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function stdDev(arr, m) {
  if (arr.length < 2) return 0;
  const mm = m ?? mean(arr);
  return Math.sqrt(arr.reduce((acc, v) => acc + (v - mm) ** 2, 0) / arr.length);
}

// Precisão radial (estilo alvo de dardos) — ver seção 3.2. `r` é a distância
// do clique ao centro do alvo dividida pelo raio na tela (0 = centro, 1 =
// borda). Cada zona tem um multiplicador de pontuação.
function classifyZone(r) {
  if (r <= 0.25) return { mult: 1.5, label: 'Perfeito', color: '#22d3ee' };
  if (r <= 0.50) return { mult: 1.25, label: 'Ótimo', color: '#a3e635' };
  if (r <= 0.75) return { mult: 1.0, label: 'Bom', color: '#facc15' };
  return { mult: 0.8, label: 'Raspou', color: '#fb923c' };
}

// Score composto (0–1) usado pelo algoritmo de ajuste — ver seção 5.1.
function computeCompositeScore({ hits, shots, reactionTimes, radialValues }) {
  const precisao = shots > 0 ? hits / shots : 0;
  const m = mean(reactionTimes);
  const med = median(reactionTimes);
  const sd = stdDev(reactionTimes, m);
  const velocidadeNormalizada = clamp(1 - (med - 250) / 500, 0, 1);
  const consistencia = m > 0 ? clamp(1 - sd / m, 0, 1) : 0;
  const precisaoRadial = radialValues.length ? 1 - mean(radialValues) : 0;

  const score = 0.35 * precisao + 0.25 * precisaoRadial + 0.25 * velocidadeNormalizada + 0.15 * consistencia;

  return { score, precisao, precisaoRadial, reactionMean: m, reactionMedian: med, reactionStdDev: sd, velocidadeNormalizada, consistencia };
}

/* ----------------------------------------------------------------------------
 * ALGORITMO DE AJUSTE DE SENSIBILIDADE (idêntico em espírito à v1)
 * --------------------------------------------------------------------------*/

function getDirection(feedbackKey) {
  if (feedbackKey === 'muito_lenta' || feedbackKey === 'lenta') return 'slow';
  if (feedbackKey === 'rapida' || feedbackKey === 'muito_rapida') return 'fast';
  return 'good';
}

function computeNextSensitivity({
  currentSens, feedback, roundNumber, feedbackHistory, initialSens,
  currentRoundScore, bestScoreSoFar, bestScoreSens, explorationSignRef,
}) {
  const base = FATOR_BASE[feedback];

  // 1) Annealing: o ajuste fica mais suave a cada rodada, para convergir.
  let fator = 1 + (base - 1) * (1 - 0.07 * (roundNumber - 1));

  // 2) Teimosia: 3 respostas seguidas na mesma direção → ignora o decaimento.
  const direction = getDirection(feedback);
  const last3 = [...feedbackHistory.slice(-2), feedback];
  const isStubborn = direction !== 'good' && last3.length === 3 && last3.every((f) => getDirection(f) === direction);
  if (isStubborn) fator = base;

  let nextSens = currentSens * fator;

  // 3) Exploração no "Boa": alterna ×1.03 / ×0.97 para testar as bordas.
  if (feedback === 'boa') {
    const sign = explorationSignRef.current;
    nextSens = currentSens * (sign === 1 ? 1.03 : 0.97);
    explorationSignRef.current = sign * -1;
  }

  // 4) Correção por desempenho: "Boa" mas score caiu >10% do melhor → puxa
  // 40% do caminho de volta para a sens da melhor rodada.
  if (feedback === 'boa' && bestScoreSoFar != null && bestScoreSens != null && bestScoreSoFar > 0) {
    const drop = (bestScoreSoFar - currentRoundScore) / bestScoreSoFar;
    if (drop > 0.10) nextSens = nextSens + 0.40 * (bestScoreSens - nextSens);
  }

  // 5) Limites de segurança.
  const min = Math.max(SENS_MIN_ABSOLUTE, initialSens * 0.35);
  const max = initialSens * 2.8;
  return round3(clamp(nextSens, min, max));
}

/* ----------------------------------------------------------------------------
 * IMPORTAÇÃO DE CFG — parser por regex + cvars reconhecidos
 * --------------------------------------------------------------------------*/

const CVAR_DEFS = [
  { key: 'sensitivity', label: 'Sensibilidade' },
  { key: 'm_yaw', label: 'm_yaw' },
  { key: 'm_pitch', label: 'm_pitch' },
  { key: 'zoom_sensitivity_ratio', label: 'zoom_sensitivity_ratio (só exibido)' },
  { key: 'm_rawinput', label: 'm_rawinput (informativo)' },
  { key: 'cl_crosshairstyle', label: 'Estilo' },
  { key: 'cl_crosshairsize', label: 'Tamanho' },
  { key: 'cl_crosshairthickness', label: 'Espessura' },
  { key: 'cl_crosshairgap', label: 'Gap' },
  { key: 'cl_crosshairdot', label: 'Ponto central' },
  { key: 'cl_crosshair_t', label: 'Estilo T' },
  { key: 'cl_crosshair_drawoutline', label: 'Contorno' },
  { key: 'cl_crosshair_outlinethickness', label: 'Espessura do contorno' },
  { key: 'cl_crosshaircolor', label: 'Cor (preset 0–5)' },
  { key: 'cl_crosshaircolor_r', label: 'Cor R' },
  { key: 'cl_crosshaircolor_g', label: 'Cor G' },
  { key: 'cl_crosshaircolor_b', label: 'Cor B' },
  { key: 'cl_crosshairalpha', label: 'Transparência (0–255)' },
];

const DEFAULT_CS2_CROSSHAIR = {
  cl_crosshairstyle: '4', cl_crosshairsize: '2.5', cl_crosshairthickness: '0.5',
  cl_crosshairgap: '-2', cl_crosshairdot: '0', cl_crosshair_t: '0',
  cl_crosshair_drawoutline: '1', cl_crosshair_outlinethickness: '1',
  cl_crosshaircolor: '1', cl_crosshaircolor_r: '50', cl_crosshaircolor_g: '250',
  cl_crosshaircolor_b: '50', cl_crosshairalpha: '200',
};

// Presets 0–4 de cl_crosshaircolor (5 = customizado via r/g/b).
const CROSSHAIR_COLOR_PRESETS = ['#EB3B00', '#00FF00', '#FFFF00', '#0000FF', '#00FFFF'];

// Extrai `chave "valor"` (ou `chave valor`, sem aspas) linha a linha,
// ignorando silenciosamente tudo que não bater — uma cfg real tem centenas
// de linhas de binds e comentários irrelevantes para este teste.
function parseCfgText(text) {
  const wanted = new Set(CVAR_DEFS.map((d) => d.key));
  const found = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s+"?(-?[0-9]*\.?[0-9]+)"?/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (wanted.has(key)) found[key] = m[2];
  }
  return found;
}

function parseDecimalStr(str) {
  if (str == null || str === '') return NaN;
  return parseFloat(String(str).replace(',', '.'));
}

// Sanitiza digitação em campos numéricos: mantém como STRING no estado
// (nunca converte pra número aqui — é isso que evita o bug de "0.550" ao
// apagar o campo), aceitando só dígitos e um separador decimal.
function sanitizeDecimalInput(raw) {
  let v = raw.replace(/[^\d.,]/g, '').replace(',', '.');
  const parts = v.split('.');
  if (parts.length > 2) v = parts[0] + '.' + parts.slice(1).join('');
  return v;
}

/* ----------------------------------------------------------------------------
 * MIRA — renderização (CS2 a partir de cvars, ponto padrão, ou PNG)
 * --------------------------------------------------------------------------*/

function CS2Crosshair({ cfg, pixelScale = 1 }) {
  const size = parseFloat(cfg.cl_crosshairsize) || 0;
  const thickness = parseFloat(cfg.cl_crosshairthickness) || 0;
  const gap = parseFloat(cfg.cl_crosshairgap) || 0;
  const dot = cfg.cl_crosshairdot === '1';
  const tStyle = cfg.cl_crosshair_t === '1';
  const outline = cfg.cl_crosshair_drawoutline !== '0';
  const outlineThickness = Math.max(0, parseFloat(cfg.cl_crosshair_outlinethickness) || 1);
  const alphaN = clamp((parseFloat(cfg.cl_crosshairalpha) ?? 200) / 255, 0, 1);
  const colorIdx = parseInt(cfg.cl_crosshaircolor, 10);
  const color = colorIdx === 5
    ? `rgb(${cfg.cl_crosshaircolor_r ?? 50}, ${cfg.cl_crosshaircolor_g ?? 250}, ${cfg.cl_crosshaircolor_b ?? 50})`
    : (CROSSHAIR_COLOR_PRESETS[colorIdx] ?? CROSSHAIR_COLOR_PRESETS[1]);

  // Aproximação: o CS2 escala a mira internamente por uma fórmula ligada à
  // resolução real do jogo, que não temos acesso no navegador. Usamos um
  // fator simples (px por "unidade" de crosshair × escala de resolução
  // simulada) — suficiente para a mira parecer plausível, não pixel-perfect.
  const px = (v) => Math.max(0, v) * 3 * pixelScale;
  const lineLength = px(size) + 6;
  const lineThickness = Math.max(1, px(thickness));
  const gapPx = px(gap);
  const outlinePx = outline ? Math.max(1, outlineThickness * pixelScale) : 0;

  const lineStyle = (extra) => ({
    position: 'absolute',
    backgroundColor: color,
    opacity: alphaN,
    boxShadow: outline ? `0 0 0 ${outlinePx}px rgba(0,0,0,0.9)` : 'none',
    ...extra,
  });

  return (
    <div style={{ position: 'relative', width: 1, height: 1 }}>
      {!tStyle && <div style={lineStyle({ left: -lineThickness / 2, top: -gapPx - lineLength, width: lineThickness, height: lineLength })} />}
      <div style={lineStyle({ left: -lineThickness / 2, top: gapPx, width: lineThickness, height: lineLength })} />
      <div style={lineStyle({ top: -lineThickness / 2, left: -gapPx - lineLength, height: lineThickness, width: lineLength })} />
      <div style={lineStyle({ top: -lineThickness / 2, left: gapPx, height: lineThickness, width: lineLength })} />
      {dot && <div style={lineStyle({ left: -lineThickness / 2, top: -lineThickness / 2, width: lineThickness, height: lineThickness })} />}
    </div>
  );
}

function CrosshairPreview({ crosshairSource, dotColor, dotSize, crosshairImage, crosshairScale, cs2Cvars, pixelScale }) {
  if (crosshairSource === 'cfg' && cs2Cvars) return <CS2Crosshair cfg={cs2Cvars} pixelScale={pixelScale} />;
  if (crosshairSource === 'image' && crosshairImage) {
    const size = 28 * crosshairScale;
    return <img src={crosshairImage} alt="" draggable={false} style={{ width: size, height: size, pointerEvents: 'none', userSelect: 'none' }} />;
  }
  return (
    <div style={{ width: dotSize, height: dotSize, borderRadius: '9999px', backgroundColor: dotColor, boxShadow: `0 0 6px ${dotColor}, 0 0 2px ${dotColor}` }} />
  );
}

/* ----------------------------------------------------------------------------
 * COMPONENTES AUXILIARES DE UI
 * --------------------------------------------------------------------------*/

function formatNumber(v, digits = 2) {
  if (v == null || Number.isNaN(v)) return '—';
  return v.toFixed(digits);
}

function DualAxisLineChart({ rounds, primaryKey, primaryLabel, primaryColor, secondaryColor }) {
  const width = 640, height = 220;
  const padding = { top: 16, right: 16, bottom: 28, left: 16 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;

  const normalize = (vals) => {
    const min = Math.min(...vals), max = Math.max(...vals);
    const range = max - min || 1;
    return vals.map((v) => 1 - (v - min) / range);
  };
  const primaryNorm = normalize(rounds.map((r) => r[primaryKey]));
  const secondaryNorm = normalize(rounds.map((r) => r.sens));

  const xFor = (i) => padding.left + (innerW * i) / (rounds.length - 1 || 1);
  const yFor = (n) => padding.top + innerH * n;
  const pathFrom = (norm) => norm.map((n, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i).toFixed(1)} ${yFor(n).toFixed(1)}`).join(' ');

  return (
    <div className="w-full overflow-x-auto">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full min-w-[480px]" role="img">
        <line x1={padding.left} y1={height - padding.bottom} x2={width - padding.right} y2={height - padding.bottom} stroke="#334155" strokeWidth="1" />
        <path d={pathFrom(secondaryNorm)} fill="none" stroke={secondaryColor} strokeWidth="2" strokeDasharray="4 3" opacity="0.7" />
        <path d={pathFrom(primaryNorm)} fill="none" stroke={primaryColor} strokeWidth="2.5" />
        {primaryNorm.map((n, i) => <circle key={i} cx={xFor(i)} cy={yFor(n)} r="3" fill={primaryColor} />)}
        {rounds.map((r, i) => (
          <text key={i} x={xFor(i)} y={height - padding.bottom + 16} fontSize="9" fill="#64748b" textAnchor="middle" fontFamily="monospace">{r.roundNumber}</text>
        ))}
      </svg>
      <div className="flex items-center gap-4 mt-1 text-xs font-mono">
        <span className="flex items-center gap-1.5" style={{ color: primaryColor }}><span className="inline-block w-3 h-0.5" style={{ backgroundColor: primaryColor }} /> {primaryLabel}</span>
        <span className="flex items-center gap-1.5" style={{ color: secondaryColor }}><span className="inline-block w-3 h-0.5 border-t border-dashed" style={{ borderColor: secondaryColor }} /> sensibilidade</span>
      </div>
    </div>
  );
}

// Mapa de dispersão dos acertos, normalizados a um alvo genérico — revela
// viés sistemático (ex.: tendência a acertar à direita do centro = overshoot
// horizontal, sinal clássico de sensibilidade alta demais).
function HitScatterPlot({ points }) {
  const size = 220, center = size / 2, R = size / 2 - 12;
  const rings = [0.25, 0.5, 0.75, 1];
  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="w-full max-w-[240px] mx-auto">
      {rings.map((f) => <circle key={f} cx={center} cy={center} r={R * f} fill="none" stroke="#1e293b" strokeWidth="1" />)}
      <line x1={center - R} y1={center} x2={center + R} y2={center} stroke="#1e293b" strokeWidth="1" />
      <line x1={center} y1={center - R} x2={center} y2={center + R} stroke="#1e293b" strokeWidth="1" />
      {points.map((p, i) => (
        <circle key={i} cx={center + clamp(p.x, -1.4, 1.4) * R} cy={center + clamp(p.y, -1.4, 1.4) * R} r="2.5" fill="#22d3ee" opacity="0.65" />
      ))}
    </svg>
  );
}

/* ----------------------------------------------------------------------------
 * TELA: CONFIGURAÇÃO
 * --------------------------------------------------------------------------*/

const DEFAULT_CONFIG = {
  dpiStr: '800',
  sensStr: '1.00',
  game: 'cs2',
  resolutionIdx: DEFAULT_RESOLUTION_IDX,
  displayMode: 'native',
  crosshairSource: 'dot',
  dotColor: '#22d3ee',
  dotSize: 4,
  crosshairImage: null,
  crosshairScale: 1,
  cs2Cvars: null,
  cvarsRecognized: [],
  mYawOverrideStr: '',
  mPitchOverrideStr: '',
  fireButton: 'left',
};

const MAX_CROSSHAIR_IMAGE_BYTES = 2 * 1024 * 1024;

function ConfigScreen({ config, setConfig, onStart }) {
  const [imageError, setImageError] = useState('');
  const [cfgText, setCfgText] = useState('');
  const [cfgError, setCfgError] = useState('');

  const gamePreset = GAME_PRESETS[config.game];
  const dpiNum = parseDecimalStr(config.dpiStr);
  const sensNum = parseDecimalStr(config.sensStr);
  const dpiValid = Number.isFinite(dpiNum) && dpiNum >= 100 && dpiNum <= 32000;
  const sensValid = Number.isFinite(sensNum) && sensNum > 0;
  const mYawEffective = config.mYawOverrideStr ? parseDecimalStr(config.mYawOverrideStr) : gamePreset.mYaw;
  const canStart = dpiValid && sensValid && Number.isFinite(mYawEffective) && mYawEffective > 0;

  const applyCfgText = (text) => {
    const parsed = parseCfgText(text);
    const recognized = CVAR_DEFS.filter((d) => d.key in parsed).map((d) => ({ ...d, value: parsed[d.key] }));
    if (!recognized.length) {
      setCfgError('Nenhum cvar reconhecido nesse texto — confira se colou o conteúdo certo.');
      return;
    }
    setCfgError('');
    setConfig((c) => {
      const next = { ...c, cvarsRecognized: recognized };
      if (parsed.sensitivity) next.sensStr = parsed.sensitivity;
      if (parsed.m_yaw) next.mYawOverrideStr = parsed.m_yaw;
      if (parsed.m_pitch) next.mPitchOverrideStr = parsed.m_pitch;
      if (Object.keys(parsed).some((k) => k.startsWith('cl_crosshair'))) {
        next.crosshairSource = 'cfg';
        next.cs2Cvars = { ...DEFAULT_CS2_CROSSHAIR, ...parsed };
      }
      return next;
    });
  };

  const handleCfgFileUpload = (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { const text = String(reader.result || ''); setCfgText(text); applyCfgText(text); };
    reader.onerror = () => setCfgError('Não foi possível ler o arquivo .cfg.');
    reader.readAsText(file);
  };

  const updateRecognizedValue = (key, value) => {
    setConfig((c) => {
      const cvarsRecognized = c.cvarsRecognized.map((item) => (item.key === key ? { ...item, value } : item));
      const next = { ...c, cvarsRecognized };
      if (key === 'sensitivity') next.sensStr = value;
      else if (key === 'm_yaw') next.mYawOverrideStr = value;
      else if (key === 'm_pitch') next.mPitchOverrideStr = value;
      else if (key.startsWith('cl_crosshair')) next.cs2Cvars = { ...(c.cs2Cvars || DEFAULT_CS2_CROSSHAIR), [key]: value };
      return next;
    });
  };

  const handleImageUpload = (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setImageError('');
    if (file.type !== 'image/png') { setImageError('Arquivo inválido: envie um PNG com transparência.'); setConfig((c) => ({ ...c, crosshairSource: 'dot' })); return; }
    if (file.size > MAX_CROSSHAIR_IMAGE_BYTES) { setImageError('Arquivo muito grande: o limite é 2MB.'); setConfig((c) => ({ ...c, crosshairSource: 'dot' })); return; }
    const reader = new FileReader();
    reader.onload = () => setConfig((c) => ({ ...c, crosshairSource: 'image', crosshairImage: reader.result }));
    reader.onerror = () => { setImageError('Não foi possível ler o arquivo. Tente novamente.'); setConfig((c) => ({ ...c, crosshairSource: 'dot' })); };
    reader.readAsDataURL(file);
  };

  const res = RESOLUTIONS[config.resolutionIdx];
  const previewScale = res.h / 1080;

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-slate-100 flex items-center justify-center p-6">
      <div className="w-full max-w-2xl bg-slate-900/60 border border-slate-800 rounded-2xl p-8 space-y-8">
        <div className="text-center space-y-1">
          <div className="flex items-center justify-center gap-2 text-cyan-400">
            <Crosshair size={26} />
            <h1 className="text-2xl font-bold text-slate-50">Sensitivity Finder</h1>
          </div>
          <p className="text-slate-400 text-sm">Motor de mira fiel ao CS2/Valorant — câmera em perspectiva, não um ponteiro na tela.</p>
        </div>

        <div className="grid grid-cols-2 gap-5">
          <div>
            <label className="block text-sm text-slate-300 mb-1">DPI do mouse *</label>
            <input
              type="text" inputMode="decimal" value={config.dpiStr}
              onChange={(e) => setConfig((c) => ({ ...c, dpiStr: sanitizeDecimalInput(e.target.value) }))}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 font-mono focus:outline-none focus:ring-2 focus:ring-cyan-500"
            />
            {!dpiValid && <p className="text-xs text-rose-400 mt-1">Informe um DPI entre 100 e 32000.</p>}
          </div>
          <div>
            <label className="block text-sm text-slate-300 mb-1">Sensibilidade do jogo *</label>
            <input
              type="text" inputMode="decimal" value={config.sensStr}
              onChange={(e) => setConfig((c) => ({ ...c, sensStr: sanitizeDecimalInput(e.target.value) }))}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 font-mono focus:outline-none focus:ring-2 focus:ring-cyan-500"
            />
            {!sensValid && <p className="text-xs text-rose-400 mt-1">Informe um valor maior que zero.</p>}
          </div>

          <div>
            <label className="block text-sm text-slate-300 mb-1">Jogo</label>
            <div className="flex gap-2">
              {Object.entries(GAME_PRESETS).map(([key, preset]) => (
                <button key={key} type="button" onClick={() => setConfig((c) => ({ ...c, game: key }))}
                  className={`px-3 py-1.5 rounded-lg text-sm border ${config.game === key ? 'bg-cyan-500/20 border-cyan-500 text-cyan-300' : 'border-slate-700 text-slate-400'}`}>
                  {preset.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-sm text-slate-300 mb-1">Botão de disparo</label>
            <div className="flex gap-2">
              <button type="button" onClick={() => setConfig((c) => ({ ...c, fireButton: 'left' }))}
                className={`px-3 py-1.5 rounded-lg text-sm border ${config.fireButton === 'left' ? 'bg-cyan-500/20 border-cyan-500 text-cyan-300' : 'border-slate-700 text-slate-400'}`}>Esquerdo</button>
              <button type="button" onClick={() => setConfig((c) => ({ ...c, fireButton: 'right' }))}
                className={`px-3 py-1.5 rounded-lg text-sm border ${config.fireButton === 'right' ? 'bg-cyan-500/20 border-cyan-500 text-cyan-300' : 'border-slate-700 text-slate-400'}`}>Direito</button>
            </div>
          </div>

          <div>
            <label className="block text-sm text-slate-300 mb-1">Resolução</label>
            <select value={config.resolutionIdx} onChange={(e) => setConfig((c) => ({ ...c, resolutionIdx: Number(e.target.value) }))}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm">
              {RESOLUTIONS.map((r, i) => <option key={r.label} value={i}>{r.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm text-slate-300 mb-1">Modo de tela</label>
            <select value={config.displayMode} onChange={(e) => setConfig((c) => ({ ...c, displayMode: e.target.value }))}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm">
              {DISPLAY_MODES.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
            </select>
          </div>
        </div>

        <div className="text-xs text-slate-500 bg-slate-800/30 rounded-lg px-3 py-2">
          Em cm/360 a sensibilidade não muda com a resolução — o que muda é a <span className="text-slate-300">proporção de tela</span>, que altera o FOV horizontal e por isso "parece" mais rápida esticada em 4:3.
        </div>

        <div className="text-sm text-slate-400 font-mono bg-slate-800/50 rounded-lg px-3 py-2 flex gap-6 flex-wrap">
          <span>eDPI: <span className="text-cyan-300">{dpiValid && sensValid ? formatNumber(calcEDPI(dpiNum, sensNum), 0) : '—'}</span></span>
          <span>cm/360: <span className="text-cyan-300">{dpiValid && sensValid && mYawEffective ? formatNumber(calcCm360(dpiNum, sensNum, mYawEffective), 1) : '—'}</span></span>
          <span>m_yaw: <span className="text-cyan-300">{mYawEffective || '—'}</span></span>
        </div>

        {/* Importar CFG */}
        <div className="space-y-2">
          <label className="flex items-center gap-1.5 text-sm text-slate-300"><FileText size={14} /> Importar config (.cfg)</label>
          <textarea
            value={cfgText}
            onChange={(e) => setCfgText(e.target.value)}
            placeholder='Cole sua config aqui (ex.: sensitivity "1.2" / cl_crosshairsize "3" ...)'
            rows={3}
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-cyan-500"
          />
          <div className="flex gap-2">
            <button type="button" onClick={() => applyCfgText(cfgText)} className="px-3 py-1.5 rounded-lg text-xs border border-slate-700 hover:border-cyan-500">Ler config colada</button>
            <label className="px-3 py-1.5 rounded-lg text-xs border border-slate-700 hover:border-cyan-500 cursor-pointer flex items-center gap-1.5">
              <Upload size={12} /> Upload .cfg
              <input type="file" accept=".cfg,text/plain" className="hidden" onChange={handleCfgFileUpload} />
            </label>
          </div>
          {cfgError && <p className="text-xs text-rose-400 flex items-center gap-1"><AlertTriangle size={12} /> {cfgError}</p>}
          {config.cvarsRecognized.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs text-slate-400">Reconhecido ({config.cvarsRecognized.length} cvars) — edite se algo estiver errado:</p>
              <div className="grid grid-cols-2 gap-1.5 max-h-40 overflow-y-auto pr-1">
                {config.cvarsRecognized.map((item) => (
                  <div key={item.key} className="flex items-center gap-1.5 bg-slate-800/50 rounded px-2 py-1">
                    <span className="text-[11px] text-slate-400 flex-1 truncate" title={item.key}>{item.label}</span>
                    <input type="text" value={item.value} onChange={(e) => updateRecognizedValue(item.key, e.target.value)}
                      className="w-16 bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-[11px] font-mono text-right" />
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="flex items-center gap-2">
            <input type="text" disabled placeholder="CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx"
              className="flex-1 bg-slate-900/50 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-slate-600 cursor-not-allowed" />
            <span className="text-[11px] text-slate-500 whitespace-nowrap">código de mira — em breve</span>
          </div>
        </div>

        {/* Mira */}
        <div className="space-y-3">
          <label className="block text-sm text-slate-300">Mira</label>
          <div className="flex gap-2 flex-wrap">
            <button type="button" onClick={() => setConfig((c) => ({ ...c, crosshairSource: 'dot' }))}
              className={`px-3 py-1.5 rounded-lg text-sm border ${config.crosshairSource === 'dot' ? 'bg-cyan-500/20 border-cyan-500 text-cyan-300' : 'border-slate-700 text-slate-400'}`}>Padrão (ponto)</button>
            <label className={`px-3 py-1.5 rounded-lg text-sm border cursor-pointer flex items-center gap-1.5 ${config.crosshairSource === 'image' ? 'bg-cyan-500/20 border-cyan-500 text-cyan-300' : 'border-slate-700 text-slate-400'}`}>
              <Upload size={14} /> PNG
              <input type="file" accept="image/png" className="hidden" onChange={handleImageUpload} />
            </label>
            {config.cs2Cvars && (
              <button type="button" onClick={() => setConfig((c) => ({ ...c, crosshairSource: 'cfg' }))}
                className={`px-3 py-1.5 rounded-lg text-sm border ${config.crosshairSource === 'cfg' ? 'bg-cyan-500/20 border-cyan-500 text-cyan-300' : 'border-slate-700 text-slate-400'}`}>Da config (CS2)</button>
            )}
          </div>
          {imageError && <p className="text-xs text-rose-400 flex items-center gap-1"><AlertTriangle size={12} /> {imageError}</p>}

          {config.crosshairSource === 'dot' && (
            <div className="flex items-center gap-6 flex-wrap">
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-400">Cor</span>
                <input type="color" value={config.dotColor} onChange={(e) => setConfig((c) => ({ ...c, dotColor: e.target.value }))} className="w-8 h-8 bg-transparent border border-slate-700 rounded cursor-pointer" />
              </div>
              <div className="flex items-center gap-2 flex-1 min-w-[160px]">
                <span className="text-xs text-slate-400 whitespace-nowrap">Tamanho ({config.dotSize}px)</span>
                <input type="range" min={2} max={8} value={config.dotSize} onChange={(e) => setConfig((c) => ({ ...c, dotSize: Number(e.target.value) }))} className="flex-1" />
              </div>
            </div>
          )}
          {config.crosshairSource === 'image' && config.crosshairImage && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-400 whitespace-nowrap">Escala ({config.crosshairScale.toFixed(1)}×)</span>
              <input type="range" min={0.5} max={3} step={0.1} value={config.crosshairScale} onChange={(e) => setConfig((c) => ({ ...c, crosshairScale: Number(e.target.value) }))} className="flex-1" />
            </div>
          )}

          <div>
            <p className="text-xs text-slate-500 mb-1">Prévia</p>
            <div className="h-28 rounded-lg bg-black border border-slate-800 flex items-center justify-center">
              <CrosshairPreview {...config} pixelScale={previewScale} />
            </div>
          </div>
        </div>

        <button type="button" disabled={!canStart} onClick={onStart}
          className="w-full py-3 rounded-xl bg-cyan-500 hover:bg-cyan-400 disabled:bg-slate-700 disabled:text-slate-500 disabled:cursor-not-allowed text-slate-950 font-semibold flex items-center justify-center gap-2 transition-colors">
          <Play size={18} /> Iniciar
        </button>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * TELA: CALIBRAÇÃO (raw input)
 * --------------------------------------------------------------------------*/

function CalibrationScreen({ onDone, onSkip }) {
  const [phase, setPhase] = useState('intro'); // intro | measuring1 | done1 | measuring2 | result
  const [sums, setSums] = useState({ raw: null, adjusted: null });
  const [rawAvailable, setRawAvailable] = useState(true);
  const areaRef = useRef(null);

  const runPhase = useCallback(async (useRaw, onFinish) => {
    const el = areaRef.current;
    if (!el) return;
    let sum = 0;
    const raw = await requestPointerLockSafe(el, useRaw);
    if (useRaw) setRawAvailable(raw);

    function onMove(e) { sum += Math.abs(e.movementX); }
    document.addEventListener('mousemove', onMove);
    await new Promise((resolve) => setTimeout(resolve, CALIBRATION_MS));
    document.removeEventListener('mousemove', onMove);
    if (document.pointerLockElement === el) document.exitPointerLock();
    onFinish(sum);
  }, []);

  useEffect(() => () => { if (document.pointerLockElement) document.exitPointerLock(); }, []);

  const deviationPct = sums.raw && sums.raw > 0 ? Math.abs(sums.raw - sums.adjusted) / sums.raw : 0;
  const deviationDetected = phase === 'result' && deviationPct > 0.03;

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-slate-100 flex items-center justify-center p-6 select-none">
      <div ref={areaRef} className="w-full max-w-xl bg-slate-900/60 border border-slate-800 rounded-2xl p-8 space-y-6 text-center">
        <div className="flex items-center justify-center gap-2 text-cyan-400">
          <Target size={22} />
          <h2 className="text-lg font-semibold text-slate-50">Calibração de input bruto</h2>
        </div>

        {phase === 'intro' && (
          <div className="space-y-4">
            <p className="text-sm text-slate-400">Vamos comparar o movimento do seu mouse com e sem "raw input" para checar se o Windows está alterando a leitura. Isso acontece uma única vez, antes da rodada 1.</p>
            <p className="text-sm text-slate-300">Fase 1: quando clicar, mova o mouse rapidamente de um lado a outro por ~1 segundo.</p>
            <button onClick={() => { setPhase('measuring1'); runPhase(true, (sum) => { setSums((s) => ({ ...s, raw: sum })); setPhase('done1'); }); }}
              className="px-5 py-2.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold">Começar Fase 1</button>
            <div><button onClick={onSkip} className="text-xs text-slate-500 hover:text-slate-300 underline">Pular calibração</button></div>
          </div>
        )}
        {phase === 'measuring1' && <p className="text-cyan-300 animate-pulse">Mova o mouse rapidamente de um lado a outro…</p>}
        {phase === 'done1' && (
          <div className="space-y-4">
            <p className="text-sm text-slate-300">Fase 2: agora repita o mesmo movimento, sem raw input.</p>
            <button onClick={() => { setPhase('measuring2'); runPhase(false, (sum) => { setSums((s) => ({ ...s, adjusted: sum })); setPhase('result'); }); }}
              className="px-5 py-2.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold">Começar Fase 2</button>
          </div>
        )}
        {phase === 'measuring2' && <p className="text-cyan-300 animate-pulse">Mova o mouse rapidamente de um lado a outro…</p>}
        {phase === 'result' && (
          <div className="space-y-4">
            {!rawAvailable && (
              <p className="text-sm text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg p-3">Seu navegador não forneceu input bruto — a sensação pode diferir do jogo. Use Chrome/Edge no Windows para o teste mais fiel.</p>
            )}
            {deviationDetected ? (
              <p className="text-sm text-rose-400 bg-rose-500/10 border border-rose-500/30 rounded-lg p-3">Seu Windows está aplicando aceleração ou uma escala de ponteiro diferente do padrão (desvio de {(deviationPct * 100).toFixed(0)}%). Coloque a velocidade em 6/11 e desligue "Melhorar a precisão do ponteiro".</p>
            ) : (
              <p className="text-sm text-lime-300 bg-lime-500/10 border border-lime-500/30 rounded-lg p-3">Sem desvio relevante detectado ({(deviationPct * 100).toFixed(1)}%) — sua configuração de mouse no Windows parece consistente.</p>
            )}
            <button onClick={() => onDone(deviationDetected, rawAvailable)} className="px-5 py-2.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold flex items-center gap-2 mx-auto">
              Continuar <ChevronRight size={18} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * TELA: RODADA — o motor de mira
 * --------------------------------------------------------------------------*/

function TargetVisual({ color }) {
  const Ring = ({ pct }) => (
    <div className="absolute rounded-full pointer-events-none" style={{ left: '50%', top: '50%', width: `${pct * 100}%`, height: `${pct * 100}%`, transform: 'translate(-50%,-50%)', border: '1px solid rgba(255,255,255,0.10)' }} />
  );
  return (
    <>
      <div className="absolute inset-0 rounded-full" style={{ backgroundColor: color, boxShadow: `0 0 18px ${color}, 0 0 6px ${color}` }} />
      <Ring pct={0.25} />
      <Ring pct={0.5} />
      <Ring pct={0.75} />
    </>
  );
}

function RoundScreen({ roundNumber, sens, dpi, mYaw, mPitch, aspect, displayMode, crosshairConfig, fireButton, onComplete }) {
  const [phase, setPhase] = useState('waiting-start');
  const [countdown, setCountdown] = useState(COUNTDOWN_SEC);
  const [paused, setPaused] = useState(false);
  const [locked, setLocked] = useState(false);
  const [rawInputActive, setRawInputActive] = useState(true);
  const [timeLeftSec, setTimeLeftSec] = useState(ROUND_DURATION_SEC);
  const [targets, setTargets] = useState([]);
  const [exitingTargets, setExitingTargets] = useState([]);
  const [floatingTexts, setFloatingTexts] = useState([]);
  const [stats, setStats] = useState({ shots: 0, hits: 0, misses: 0, expired: 0, targetsShown: 0, streak: 0, score: 0 });

  const gameAreaRef = useRef(null);
  const barLeftRef = useRef(null);
  const barRightRef = useRef(null);
  const targetNodeRefs = useRef(new Map());

  const pausedRef = useRef(false);
  const targetsRef = useRef([]);
  const statsRef = useRef(stats);
  const idCounterRef = useRef(1);

  const camYawRef = useRef(0);
  const camPitchRef = useRef(0);
  const projectionParamsRef = useRef({ hFOV: 90, focal: 500, stretchX: 1, barsPx: 0 });

  const elapsedRef = useRef(0);
  const lastTickRef = useRef(0);
  const lastSpawnElapsedRef = useRef(0);
  const rafRef = useRef(null);

  const reactionTimesRef = useRef([]);
  const radialValuesRef = useRef([]);
  const hitPointsRef = useRef([]);

  const sensRef = useRef(sens);
  const mYawRef = useRef(mYaw);
  const mPitchRef = useRef(mPitch);
  useEffect(() => { sensRef.current = sens; mYawRef.current = mYaw; mPitchRef.current = mPitch; }, [sens, mYaw, mPitch]);

  const syncStats = useCallback(() => setStats({ ...statsRef.current }), []);
  const syncTargets = useCallback(() => setTargets([...targetsRef.current]), []);
  const setPausedBoth = useCallback((v) => { pausedRef.current = v; setPaused(v); }, []);

  const pushFloatingText = useCallback((label, color) => {
    const id = `ft-${Date.now()}-${Math.random()}`;
    setFloatingTexts((prev) => [...prev, { id, label, color }]);
    setTimeout(() => setFloatingTexts((prev) => prev.filter((f) => f.id !== id)), 700);
  }, []);

  /* ---- projeção: recalcula posição na tela de cada alvo a partir da câmera ---- */
  const projectAndRenderAll = useCallback(() => {
    const area = gameAreaRef.current;
    if (!area) return;
    const w = area.clientWidth, h = area.clientHeight;
    const { hFOV, focal, stretchX } = projectionParamsRef.current;
    const camYaw = camYawRef.current, camPitch = camPitchRef.current;
    const hFovHalf = hFOV / 2;

    for (const t of targetsRef.current) {
      const node = targetNodeRefs.current.get(t.id);
      if (!node) continue;
      const dYaw = normalizeAngleSigned(t.yaw - camYaw);
      const dPitch = t.pitch - camPitch;
      if (Math.abs(dYaw) > hFovHalf + CULL_MARGIN_DEG) {
        node.style.display = 'none';
        t.lastProjected = null;
        continue;
      }
      const offX = focal * Math.tan(degToRad(dYaw)) * stretchX;
      const offY = focal * Math.tan(degToRad(dPitch));
      const screenX = w / 2 + offX;
      const screenY = h / 2 - offY;
      const radiusPx = Math.max(TARGET_MIN_RADIUS_PX, focal * Math.tan(degToRad(t.angularSizeDeg / 2)));
      node.style.display = 'block';
      node.style.width = `${radiusPx * 2}px`;
      node.style.height = `${radiusPx * 2}px`;
      node.style.transform = `translate(${screenX}px, ${screenY}px) translate(-50%, -50%)`;
      t.lastProjected = { x: screenX, y: screenY, radiusPx };
    }
  }, []);

  useLayoutEffect(() => { projectAndRenderAll(); }, [targets, projectAndRenderAll]);

  /* ---- parâmetros de projeção (FOV/focal), recalculados no resize ---- */
  useEffect(() => {
    function updateParams() {
      const area = gameAreaRef.current;
      if (!area) return;
      const params = computeProjectionParams(displayMode, aspect, area.clientWidth, area.clientHeight);
      projectionParamsRef.current = params;
      if (barLeftRef.current && barRightRef.current) {
        const bw = params.barsPx || 0;
        barLeftRef.current.style.width = `${bw}px`;
        barRightRef.current.style.width = `${bw}px`;
        barLeftRef.current.style.display = bw > 0 ? 'block' : 'none';
        barRightRef.current.style.display = bw > 0 ? 'block' : 'none';
      }
      projectAndRenderAll();
    }
    updateParams();
    window.addEventListener('resize', updateParams);
    return () => window.removeEventListener('resize', updateParams);
  }, [displayMode, aspect, projectAndRenderAll]);

  /* ---- fim da rodada ---- */
  const finishedRef = useRef(false);
  const endRound = useCallback(() => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (document.pointerLockElement === gameAreaRef.current) document.exitPointerLock();

    const composite = computeCompositeScore({
      hits: statsRef.current.hits, shots: statsRef.current.shots,
      reactionTimes: reactionTimesRef.current, radialValues: radialValuesRef.current,
    });

    onComplete({
      roundNumber, sens, dpi,
      eDPI: calcEDPI(dpi, sens),
      cm360: calcCm360(dpi, sens, mYaw),
      shots: statsRef.current.shots, hits: statsRef.current.hits, misses: statsRef.current.misses,
      expired: statsRef.current.expired, targetsShown: statsRef.current.targetsShown,
      precisao: composite.precisao, precisaoRadial: composite.precisaoRadial,
      taxaConclusao: statsRef.current.targetsShown > 0 ? statsRef.current.hits / statsRef.current.targetsShown : 0,
      reactionMean: composite.reactionMean, reactionMedian: composite.reactionMedian, reactionStdDev: composite.reactionStdDev,
      points: statsRef.current.score, scoreComposto: composite.score,
      hitPoints: hitPointsRef.current,
    });
  }, [roundNumber, sens, dpi, mYaw, onComplete]);

  /* ---- spawn de alvo (em coordenadas de mundo) ---- */
  const spawnTarget = useCallback(() => {
    const distance = sampleDistanceM();
    const angularSizeDeg = 2 * radToDeg(Math.atan((HEAD_WIDTH_M / 2) / distance));
    const yaw = (Math.random() * 2 - 1) * BOX_HALF_YAW_DEG;
    const pitch = (Math.random() * 2 - 1) * BOX_HALF_PITCH_DEG;
    const color = NEON_COLORS[Math.floor(Math.random() * NEON_COLORS.length)];
    targetsRef.current.push({ id: idCounterRef.current++, yaw, pitch, distance, angularSizeDeg, color, spawnElapsed: elapsedRef.current, wrongHits: 0, lastProjected: null });
    syncTargets();
    statsRef.current.targetsShown += 1;
    syncStats();
  }, [syncTargets, syncStats]);

  const removeTarget = useCallback((id, reason) => {
    const t = targetsRef.current.find((tg) => tg.id === id);
    targetsRef.current = targetsRef.current.filter((tg) => tg.id !== id);
    targetNodeRefs.current.delete(id);
    syncTargets();
    if (t && t.lastProjected) {
      const ghostId = `ghost-${id}-${Date.now()}`;
      setExitingTargets((prev) => [...prev, { x: t.lastProjected.x, y: t.lastProjected.y, radiusPx: t.lastProjected.radiusPx, color: t.color, ghostId, reason }]);
      setTimeout(() => setExitingTargets((prev) => prev.filter((g) => g.ghostId !== ghostId)), 220);
    }
  }, [syncTargets]);

  /* ---- disparo: a mira é sempre o centro da tela ---- */
  const registerShot = useCallback(() => {
    const area = gameAreaRef.current;
    if (!area) return;
    const cx = area.clientWidth / 2, cy = area.clientHeight / 2;
    const current = targetsRef.current;

    let hit = null, hitR = Infinity;
    for (const t of current) {
      if (!t.lastProjected) continue;
      const r = Math.hypot(cx - t.lastProjected.x, cy - t.lastProjected.y) / t.lastProjected.radiusPx;
      if (r <= 1 && r < hitR) { hitR = r; hit = t; }
    }

    if (!hit) {
      let nearest = null, nearestDist = Infinity;
      for (const t of current) {
        if (!t.lastProjected) continue;
        const d = Math.hypot(cx - t.lastProjected.x, cy - t.lastProjected.y);
        if (d < nearestDist) { nearestDist = d; nearest = t; }
      }
      if (nearest && nearestDist <= nearest.lastProjected.radiusPx * NEAR_MISS_RADIUS_MULT) {
        nearest.wrongHits += 1;
        if (nearest.wrongHits >= TARGET_MAX_WRONG_HITS) {
          removeTarget(nearest.id, 'wrong-hits');
          statsRef.current.expired += 1;
        }
      }
      statsRef.current.shots += 1;
      statsRef.current.misses += 1;
      statsRef.current.streak = 0;
      statsRef.current.score = Math.max(0, statsRef.current.score - 25);
      syncStats();
      return;
    }

    const reaction = elapsedRef.current - hit.spawnElapsed;
    reactionTimesRef.current.push(reaction);
    radialValuesRef.current.push(hitR);
    hitPointsRef.current.push({
      x: (cx - hit.lastProjected.x) / hit.lastProjected.radiusPx,
      y: (cy - hit.lastProjected.y) / hit.lastProjected.radiusPx,
    });

    const zone = classifyZone(hitR);
    pushFloatingText(zone.label, zone.color);
    removeTarget(hit.id, 'hit');

    statsRef.current.shots += 1;
    statsRef.current.hits += 1;
    statsRef.current.streak += 1;
    const speedBonus = Math.max(0, 150 - reaction / 4);
    const comboMultiplier = Math.min(2.0, Math.pow(1.1, Math.floor(statsRef.current.streak / 5)));
    const gained = Math.round((100 + speedBonus) * zone.mult * comboMultiplier);
    statsRef.current.score += gained;
    syncStats();
  }, [removeTarget, syncStats, pushFloatingText]);

  /* ---- game loop: relógio lógico, spawn, expiração, timer ---- */
  const tick = useCallback(() => {
    const now = performance.now();
    const dt = now - lastTickRef.current;
    lastTickRef.current = now;

    if (!pausedRef.current) {
      elapsedRef.current += dt;

      if (elapsedRef.current - lastSpawnElapsedRef.current >= TARGET_SPAWN_INTERVAL_MS) {
        lastSpawnElapsedRef.current = elapsedRef.current;
        spawnTarget();
      }

      const expiredNow = targetsRef.current.filter((t) => elapsedRef.current - t.spawnElapsed >= TARGET_LIFETIME_MS);
      if (expiredNow.length) {
        expiredNow.forEach((t) => removeTarget(t.id, 'timeout'));
        statsRef.current.expired += expiredNow.length;
        syncStats();
      }

      const remainingMs = ROUND_DURATION_MS - elapsedRef.current;
      setTimeLeftSec(Math.max(0, Math.ceil(remainingMs / 1000)));
      if (remainingMs <= 0) { endRound(); return; }
    }
    rafRef.current = requestAnimationFrame(tick);
  }, [spawnTarget, removeTarget, syncStats, endRound]);

  /* ---- input ---- */
  useEffect(() => {
    function onMouseMove(e) {
      if (pausedRef.current) return;
      if (document.pointerLockElement !== gameAreaRef.current) return;

      // === conversão mouse → rotação de câmera ===
      // yawDelta/pitchDelta em graus; sens e m_yaw/m_pitch vêm da rodada
      // atual. camYaw aumenta girando para a direita; camPitch aumenta
      // olhando para cima (por isso o sinal invertido no pitch: movementY
      // negativo = mouse pra cima = olhar pra cima = pitch cresce).
      const yawDelta = e.movementX * sensRef.current * mYawRef.current;
      const pitchDelta = e.movementY * sensRef.current * mPitchRef.current;
      camYawRef.current = normalizeAngleSigned(camYawRef.current + yawDelta);
      camPitchRef.current = clamp(camPitchRef.current - pitchDelta, -89, 89);

      projectAndRenderAll();
    }

    function onMouseDown(e) {
      if (pausedRef.current || phase !== 'playing') return;
      if (document.pointerLockElement !== gameAreaRef.current) return;
      const isFireButton = fireButton === 'right' ? e.button === 2 : e.button === 0;
      if (!isFireButton) return;
      e.preventDefault();
      registerShot();
    }

    function onContextMenu(e) { if (fireButton === 'right') e.preventDefault(); }

    function onPointerLockChange() {
      const isLocked = document.pointerLockElement === gameAreaRef.current;
      setLocked(isLocked);
      if (isLocked) {
        if (pausedRef.current) { lastTickRef.current = performance.now(); setPausedBoth(false); }
      } else if (!finishedRef.current) {
        setPausedBoth(true);
      }
    }
    function onPointerLockError() { setPausedBoth(true); }
    function onBlur() { setPausedBoth(true); }
    function onVisibilityChange() { if (document.hidden) setPausedBoth(true); }

    document.addEventListener('mousemove', onMouseMove);
    const area = gameAreaRef.current;
    area?.addEventListener('mousedown', onMouseDown);
    area?.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('pointerlockchange', onPointerLockChange);
    document.addEventListener('pointerlockerror', onPointerLockError);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      area?.removeEventListener('mousedown', onMouseDown);
      area?.removeEventListener('contextmenu', onContextMenu);
      document.removeEventListener('pointerlockchange', onPointerLockChange);
      document.removeEventListener('pointerlockerror', onPointerLockError);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [phase, fireButton, registerShot, setPausedBoth, projectAndRenderAll]);

  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.overflow = 'hidden';
    document.body.style.userSelect = 'none';
    return () => {
      document.body.style.overflow = prevOverflow;
      document.body.style.userSelect = prevUserSelect;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (document.pointerLockElement === gameAreaRef.current) document.exitPointerLock();
    };
  }, []);

  const handleAreaClick = useCallback(() => {
    const area = gameAreaRef.current;
    if (!area) return;
    if (phase === 'waiting-start') {
      camYawRef.current = 0;
      camPitchRef.current = 0;
      requestPointerLockSafe(area, true).then(setRawInputActive);
      setPhase('countdown');
    } else if (paused) {
      requestPointerLockSafe(area, true).then(setRawInputActive);
    }
  }, [phase, paused]);

  useEffect(() => {
    if (phase !== 'countdown' || !locked) return;
    setCountdown(COUNTDOWN_SEC);
    let n = COUNTDOWN_SEC;
    const id = setInterval(() => {
      n -= 1;
      setCountdown(n);
      if (n <= 0) {
        clearInterval(id);
        setPhase('playing');
        lastTickRef.current = performance.now();
        lastSpawnElapsedRef.current = 0;
        rafRef.current = requestAnimationFrame(tick);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [phase, locked, tick]);

  const accuracy = stats.shots > 0 ? (stats.hits / stats.shots) * 100 : 0;
  const comboMultDisplay = Math.min(2.0, Math.pow(1.1, Math.floor(stats.streak / 5)));

  return (
    <div className="fixed inset-0 bg-[#0a0a0f]">
      <style>{`
        @keyframes target-in { from { transform: scale(0.3); opacity: 0; } to { transform: scale(1); opacity: 1; } }
        @keyframes target-out-hit { from { transform: translate(-50%,-50%) scale(1); opacity: 1; } to { transform: translate(-50%,-50%) scale(1.5); opacity: 0; } }
        @keyframes target-out-fade { from { transform: translate(-50%,-50%) scale(1); opacity: 1; } to { transform: translate(-50%,-50%) scale(0.7); opacity: 0; } }
        @keyframes float-up { from { opacity: 1; transform: translate(-50%,-50%) translateY(0); } to { opacity: 0; transform: translate(-50%,-50%) translateY(-40px); } }
      `}</style>

      <div ref={gameAreaRef} onClick={handleAreaClick} className="relative w-full h-full overflow-hidden cursor-none select-none">
        {targets.map((t) => (
          <div
            key={t.id}
            ref={(el) => { if (el) targetNodeRefs.current.set(t.id, el); else targetNodeRefs.current.delete(t.id); }}
            className="absolute rounded-full pointer-events-none"
            style={{ left: 0, top: 0, display: 'none', animation: 'target-in 120ms ease-out' }}
          >
            <TargetVisual color={t.color} />
          </div>
        ))}

        {exitingTargets.map((t) => (
          <div key={t.ghostId} className="absolute rounded-full pointer-events-none"
            style={{ left: t.x, top: t.y, width: t.radiusPx * 2, height: t.radiusPx * 2, backgroundColor: t.color, boxShadow: `0 0 18px ${t.color}`, animation: t.reason === 'hit' ? 'target-out-hit 200ms ease-out forwards' : 'target-out-fade 200ms ease-out forwards' }} />
        ))}

        {floatingTexts.map((f) => (
          <div key={f.id} className="absolute pointer-events-none font-bold text-sm" style={{ left: '50%', top: '46%', color: f.color, transform: 'translate(-50%,-50%)', animation: 'float-up 700ms ease-out forwards' }}>{f.label}</div>
        ))}

        {/* mira fixa no centro da tela */}
        <div className="absolute pointer-events-none z-20" style={{ left: '50%', top: '50%', transform: 'translate(-50%,-50%)' }}>
          <CrosshairPreview {...crosshairConfig} pixelScale={1} />
        </div>

        <div ref={barLeftRef} className="absolute left-0 top-0 bottom-0 bg-black pointer-events-none" style={{ width: 0, display: 'none', zIndex: 10 }} />
        <div ref={barRightRef} className="absolute right-0 top-0 bottom-0 bg-black pointer-events-none" style={{ width: 0, display: 'none', zIndex: 10 }} />

        {phase === 'playing' && (
          <div className="absolute top-4 left-4 font-mono text-sm text-slate-200 bg-black/40 rounded-lg px-4 py-2 space-y-0.5 pointer-events-none z-30">
            <div className="flex gap-4"><span>Rodada <span className="text-cyan-300">{roundNumber}/{ROUND_COUNT}</span></span><span>Tempo <span className="text-cyan-300">{timeLeftSec}s</span></span></div>
            <div className="flex gap-4"><span>Pontos <span className="text-lime-300">{stats.score}</span></span><span>Combo <span className="text-fuchsia-300">×{comboMultDisplay.toFixed(2)}</span></span></div>
            <div className="flex gap-4"><span>Acertos <span className="text-slate-100">{stats.hits}/{stats.shots}</span></span><span>Precisão <span className="text-slate-100">{accuracy.toFixed(0)}%</span></span></div>
            <div className="flex gap-4"><span>Sens <span className="text-slate-100">{sens.toFixed(3)}</span></span></div>
          </div>
        )}

        {!rawInputActive && phase !== 'waiting-start' && (
          <div className="absolute top-4 right-4 max-w-xs bg-amber-500/15 border border-amber-500/40 text-amber-200 text-xs rounded-lg px-3 py-2 flex gap-2 pointer-events-none z-30">
            <AlertTriangle size={14} className="shrink-0 mt-0.5" />
            <span>Seu navegador não forneceu input bruto — a sensação pode diferir do jogo.</span>
          </div>
        )}

        {phase === 'waiting-start' && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70">
            <div className="text-center space-y-3">
              <Gamepad2 className="mx-auto text-cyan-400" size={36} />
              <p className="text-lg text-slate-100">Rodada {roundNumber}/{ROUND_COUNT}</p>
              <p className="text-slate-400 text-sm">Clique para travar o cursor e começar</p>
            </div>
          </div>
        )}
        {phase === 'countdown' && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60 pointer-events-none">
            <span className="text-7xl font-bold text-cyan-300 font-mono">{countdown > 0 ? countdown : 'Vai!'}</span>
          </div>
        )}
        {paused && phase !== 'waiting-start' && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/80">
            <div className="text-center space-y-3">
              <Pause className="mx-auto text-amber-400" size={32} />
              <p className="text-slate-100">Pausado</p>
              <p className="text-slate-400 text-sm">Clique para retomar</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * TELA: RELATÓRIO FINAL
 * --------------------------------------------------------------------------*/

function computeFinalRecommendation(rounds) {
  const sorted = [...rounds].sort((a, b) => b.scoreComposto - a.scoreComposto);
  const top3 = sorted.slice(0, 3);
  const weights = [0.5, 0.3, 0.2];
  let weightedSum = 0, weightSum = 0;
  top3.forEach((r, i) => { weightedSum += r.sens * (weights[i] ?? 0); weightSum += weights[i] ?? 0; });
  const recommendedSens = weightSum > 0 ? weightedSum / weightSum : rounds[0].sens;
  return { recommendedSens: round3(recommendedSens), top3 };
}

// DPI: mantém o DPI atual se a sens resultante já está na faixa confortável.
// Fora disso, procura o DPI "redondo" mais próximo que traga a sens de volta
// pra faixa PRESERVANDO o eDPI (e portanto o cm/360).
function recommendDpiSens(dpi, sens, game) {
  const [lo, hi] = GAME_PRESETS[game].comfortRange;
  if (sens >= lo && sens <= hi) return { dpi, sens: round3(sens), changed: false, eDpi: dpi * sens };
  const eDpi = dpi * sens;
  const mid = (lo + hi) / 2;
  let best = null, bestDist = Infinity;
  for (const d of [400, 800, 1600, 3200]) {
    const candidateSens = eDpi / d;
    if (candidateSens >= lo && candidateSens <= hi) {
      const dist = Math.abs(candidateSens - mid);
      if (dist < bestDist) { bestDist = dist; best = { dpi: d, sens: round3(candidateSens) }; }
    }
  }
  if (!best) best = { dpi, sens: round3(sens) };
  return { ...best, changed: best.dpi !== dpi, eDpi };
}

function buildInsightText(rounds) {
  if (!rounds.length) return '';
  const maxScore = Math.max(...rounds.map((r) => r.scoreComposto));
  const strong = rounds.filter((r) => r.scoreComposto >= maxScore * 0.9);
  if (!strong.length) return '';
  const cm360s = strong.map((r) => r.cm360);
  const precs = strong.map((r) => r.precisao * 100);
  const minCm = Math.min(...cm360s), maxCm = Math.max(...cm360s);
  const minPrec = Math.min(...precs), maxPrec = Math.max(...precs);
  const fasterRounds = rounds.filter((r) => r.cm360 < minCm);
  const avgOvershootIn = mean(strong.map((r) => 1 - r.precisaoRadial));
  const avgOvershootFaster = fasterRounds.length ? mean(fasterRounds.map((r) => 1 - r.precisaoRadial)) : null;
  let extra = '';
  if (avgOvershootFaster != null && avgOvershootIn > 0) {
    const pctChange = ((avgOvershootFaster - avgOvershootIn) / avgOvershootIn) * 100;
    if (pctChange > 5) extra = ` Acima dessa faixa (sensibilidade mais alta), a dispersão dos cliques cresceu ${pctChange.toFixed(0)}%.`;
  }
  return `Sua precisão foi mais alta na faixa de ${minPrec.toFixed(0)}–${maxPrec.toFixed(0)}% de acerto, entre ${minCm.toFixed(1)}–${maxCm.toFixed(1)} cm/360.${extra}`;
}

function buildBenchmarkText(reactionMeanMs) {
  const diffPct = ((REFERENCIA_PRINCIPAL_MS - reactionMeanMs) / REFERENCIA_PRINCIPAL_MS) * 100;
  const word = diffPct >= 0 ? 'mais rápido' : 'mais lento';
  return `Curiosidade: seu tempo médio de resposta foi de ${reactionMeanMs.toFixed(0)} ms — cerca de ${Math.abs(diffPct).toFixed(0)}% ${word} que a média aproximada de jogadores de CS2 e Valorant (${REFERENCIA_PRINCIPAL_MS} ms).`;
}

function ReportScreen({ rounds, config, resolved, calibrationDeviation, onRestart, onRepeat }) {
  const rec = useMemo(() => computeFinalRecommendation(rounds), [rounds]);
  const dpiRec = useMemo(() => recommendDpiSens(resolved.dpi, rec.recommendedSens, config.game), [resolved.dpi, rec.recommendedSens, config.game]);
  const insight = useMemo(() => buildInsightText(rounds), [rounds]);
  const allHitPoints = useMemo(() => rounds.flatMap((r) => r.hitPoints || []), [rounds]);
  const reactionMeanOverall = useMemo(() => mean(rounds.map((r) => r.reactionMean)), [rounds]);
  const [copied, setCopied] = useState(false);
  const gameLabel = GAME_PRESETS[config.game].label;

  const handleCopy = async () => {
    const lines = [
      `Sensitivity Finder — Relatório (${gameLabel})`,
      `sensitivity "${dpiRec.sens}"`,
      `DPI: ${dpiRec.dpi} | eDPI: ${dpiRec.eDpi.toFixed(0)} | cm/360: ${calcCm360(dpiRec.dpi, dpiRec.sens, resolved.mYaw).toFixed(1)}`,
      '',
      insight,
      buildBenchmarkText(reactionMeanOverall),
      '',
      'Rodadas:',
      ...rounds.map((r) => `#${r.roundNumber} sens=${r.sens.toFixed(3)} eDPI=${r.eDPI.toFixed(0)} cm360=${r.cm360.toFixed(1)} precisao=${(r.precisao * 100).toFixed(0)}% precisaoRadial=${(r.precisaoRadial * 100).toFixed(0)}% reacaoMediana=${r.reactionMedian.toFixed(0)}ms pontos=${r.points} feedback=${r.feedback}`),
    ];
    if (config.cs2Cvars) {
      lines.push('', '--- bloco pronto para colar na config ---', `sensitivity "${dpiRec.sens}"`);
      for (const [k, v] of Object.entries(config.cs2Cvars)) if (k.startsWith('cl_crosshair')) lines.push(`${k} "${v}"`);
    }
    try { await navigator.clipboard.writeText(lines.join('\n')); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* clipboard indisponível */ }
  };

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-slate-100 p-6 md:p-10">
      <div className="max-w-4xl mx-auto space-y-8">
        <div className="text-center space-y-1">
          <h1 className="text-2xl font-bold">Relatório final — {gameLabel}</h1>
          <p className="text-slate-400 text-sm">{rounds.length} rodada{rounds.length !== 1 ? 's' : ''} concluída{rounds.length !== 1 ? 's' : ''}</p>
        </div>

        <div className="bg-slate-900/70 border border-cyan-500/30 rounded-xl p-5 font-mono text-sm space-y-2">
          <p className="text-cyan-400 text-xs uppercase tracking-wide mb-2">Sua configuração</p>
          <div className="grid gap-1.5">
            <div className="flex justify-between flex-wrap gap-x-2"><span className="text-slate-400">No {gameLabel} (console/menu):</span><span className="text-slate-100">sensitivity {dpiRec.sens}</span></div>
            <div className="flex justify-between flex-wrap gap-x-2"><span className="text-slate-400">No mouse (software):</span><span className="text-slate-100">{dpiRec.dpi} DPI</span></div>
            <div className="flex justify-between flex-wrap gap-x-2">
              <span className="text-slate-400">No Windows:</span>
              <span className={calibrationDeviation ? 'text-rose-400 font-semibold' : 'text-slate-100'}>velocidade 6/11, "Melhorar precisão do ponteiro" OFF</span>
            </div>
          </div>
          {dpiRec.changed && (
            <p className="text-xs text-amber-300 pt-1">DPI ajustado de {resolved.dpi} para {dpiRec.dpi}, preservando o cm/360 (mesmo eDPI) — sens fora da faixa confortável perde granularidade de ajuste (baixa demais) ou amplifica o tremor da mão (alta demais).</p>
          )}
          <div className="pt-2 border-t border-slate-800 flex gap-4 text-xs text-slate-400 flex-wrap">
            <span>eDPI {dpiRec.eDpi.toFixed(0)}</span>
            <span>{calcCm360(dpiRec.dpi, dpiRec.sens, resolved.mYaw).toFixed(1)} cm/360</span>
            <span>m_yaw {resolved.mYaw}</span>
          </div>
        </div>

        {insight && <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 flex gap-3 text-sm text-slate-300"><Info size={18} className="shrink-0 text-cyan-400 mt-0.5" /><p>{insight}</p></div>}
        <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 flex gap-3 text-sm text-slate-300">
          <Info size={18} className="shrink-0 text-cyan-400 mt-0.5" />
          <div className="space-y-1.5">
            <p>{buildBenchmarkText(reactionMeanOverall)} <span className="text-slate-500">(referência aproximada de treino de mira, medida em condições diferentes de uma partida real.)</span></p>
            <div className="flex gap-4 text-xs text-slate-500 font-mono flex-wrap">
              {Object.entries(BENCHMARK_MS).map(([tier, ms]) => <span key={tier}>{tier}: {ms}ms</span>)}
            </div>
          </div>
        </div>

        <div className="grid md:grid-cols-2 gap-6">
          <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4">
            <p className="text-sm text-slate-400 mb-2">Precisão por rodada (× sensibilidade)</p>
            <DualAxisLineChart rounds={rounds} primaryKey="precisao" primaryLabel="precisão" primaryColor="#22d3ee" secondaryColor="#c084fc" />
          </div>
          <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4">
            <p className="text-sm text-slate-400 mb-2">Reação mediana por rodada (× sensibilidade)</p>
            <DualAxisLineChart rounds={rounds} primaryKey="reactionMedian" primaryLabel="reação (ms)" primaryColor="#fb923c" secondaryColor="#c084fc" />
          </div>
        </div>

        <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4">
          <p className="text-sm text-slate-400 mb-2">Mapa de dispersão dos acertos (normalizado ao alvo)</p>
          <HitScatterPlot points={allHitPoints} />
        </div>

        <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 overflow-x-auto">
          <table className="w-full text-sm font-mono min-w-[820px]">
            <thead><tr className="text-left text-slate-500 border-b border-slate-800">
              <th className="py-2 pr-3">#</th><th className="py-2 pr-3">Sens</th><th className="py-2 pr-3">eDPI</th><th className="py-2 pr-3">cm/360</th>
              <th className="py-2 pr-3">Disparos</th><th className="py-2 pr-3">Acertos</th><th className="py-2 pr-3">Precisão</th><th className="py-2 pr-3">Prec. radial</th>
              <th className="py-2 pr-3">Reação med.</th><th className="py-2 pr-3">Pontos</th><th className="py-2 pr-3">Feedback</th>
            </tr></thead>
            <tbody>
              {rounds.map((r) => (
                <tr key={r.roundNumber} className="border-b border-slate-800/50 text-slate-200">
                  <td className="py-1.5 pr-3">{r.roundNumber}</td>
                  <td className="py-1.5 pr-3">{r.sens.toFixed(3)}</td>
                  <td className="py-1.5 pr-3">{r.eDPI.toFixed(0)}</td>
                  <td className="py-1.5 pr-3">{r.cm360.toFixed(1)}</td>
                  <td className="py-1.5 pr-3">{r.shots}</td>
                  <td className="py-1.5 pr-3">{r.hits}</td>
                  <td className="py-1.5 pr-3">{(r.precisao * 100).toFixed(0)}%</td>
                  <td className="py-1.5 pr-3">{(r.precisaoRadial * 100).toFixed(0)}%</td>
                  <td className="py-1.5 pr-3">{r.reactionMedian.toFixed(0)}ms</td>
                  <td className="py-1.5 pr-3">{r.points}</td>
                  <td className="py-1.5 pr-3 text-cyan-300">{FEEDBACK_OPTIONS.find((o) => o.key === r.feedback)?.label}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 flex gap-3 text-sm text-amber-200">
          <AlertTriangle size={18} className="shrink-0 mt-0.5" />
          <p>Este resultado é um ponto de partida, medido em alvos estáticos com flicks curtos — tracking, spray control e movimentação pedem ajustes. Teste no jogo por alguns dias antes de fixar.</p>
        </div>

        <div className="flex gap-3 justify-center flex-wrap">
          <button onClick={onRepeat} className="px-5 py-2.5 rounded-xl border border-slate-700 hover:border-slate-500 flex items-center gap-2 text-slate-200"><RotateCcw size={16} /> Repetir teste</button>
          <button onClick={onRestart} className="px-5 py-2.5 rounded-xl border border-slate-700 hover:border-slate-500 flex items-center gap-2 text-slate-200">Voltar ao início</button>
          <button onClick={handleCopy} className="px-5 py-2.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold flex items-center gap-2">
            {copied ? <Check size={16} /> : <Copy size={16} />} {copied ? 'Copiado!' : 'Copiar resultado'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * TELAS DE BLOQUEIO
 * --------------------------------------------------------------------------*/

function BlockedScreen({ icon: Icon, title, message }) {
  return (
    <div className="min-h-screen bg-[#0a0a0f] text-slate-100 flex items-center justify-center p-6">
      <div className="max-w-md text-center space-y-4">
        <Icon size={40} className="mx-auto text-amber-400" />
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="text-slate-400 text-sm">{message}</p>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * APP
 * --------------------------------------------------------------------------*/

export default function SensitivityFinder() {
  const [envStatus, setEnvStatus] = useState('checking');
  useEffect(() => {
    if (typeof document === 'undefined' || !('requestPointerLock' in Element.prototype)) { setEnvStatus('no-pointerlock'); return; }
    const hasFinePointer = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(any-pointer: fine)').matches;
    if (!hasFinePointer) { setEnvStatus('no-mouse'); return; }
    setEnvStatus('ok');
  }, []);

  const [screen, setScreen] = useState('config');
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [rounds, setRounds] = useState([]);
  const [roundIndex, setRoundIndex] = useState(0);
  const [currentSens, setCurrentSens] = useState(1);
  const [pendingSummary, setPendingSummary] = useState(null);
  const [calibrationDeviation, setCalibrationDeviation] = useState(false);

  const feedbackHistoryRef = useRef([]);
  const explorationSignRef = useRef(1);
  const bestScoreRef = useRef({ score: -Infinity, sens: null });

  const resolved = useMemo(() => {
    const dpi = parseDecimalStr(config.dpiStr);
    const initialSens = parseDecimalStr(config.sensStr);
    const preset = GAME_PRESETS[config.game];
    const mYaw = config.mYawOverrideStr ? parseDecimalStr(config.mYawOverrideStr) : preset.mYaw;
    const mPitch = config.mPitchOverrideStr ? parseDecimalStr(config.mPitchOverrideStr) : mYaw;
    const res = RESOLUTIONS[config.resolutionIdx];
    return { dpi, initialSens, mYaw, mPitch, aspect: res.w / res.h };
  }, [config]);

  const crosshairConfig = useMemo(() => ({
    crosshairSource: config.crosshairSource, dotColor: config.dotColor, dotSize: config.dotSize,
    crosshairImage: config.crosshairImage, crosshairScale: config.crosshairScale, cs2Cvars: config.cs2Cvars,
  }), [config.crosshairSource, config.dotColor, config.dotSize, config.crosshairImage, config.crosshairScale, config.cs2Cvars]);

  const resetProgress = () => {
    setRounds([]);
    setRoundIndex(0);
    setCurrentSens(resolved.initialSens);
    feedbackHistoryRef.current = [];
    explorationSignRef.current = 1;
    bestScoreRef.current = { score: -Infinity, sens: null };
  };

  const handleConfigStart = () => setScreen('calibration');
  const handleCalibrationDone = (deviation) => { setCalibrationDeviation(deviation); resetProgress(); setScreen('round'); };
  const handleCalibrationSkip = () => { setCalibrationDeviation(false); resetProgress(); setScreen('round'); };

  const handleRoundComplete = (summary) => { setPendingSummary(summary); setScreen('feedback'); };

  const applyFeedback = (feedbackKey) => {
    const nextSens = computeNextSensitivity({
      currentSens: pendingSummary.sens, feedback: feedbackKey, roundNumber: pendingSummary.roundNumber,
      feedbackHistory: feedbackHistoryRef.current, initialSens: resolved.initialSens,
      currentRoundScore: pendingSummary.scoreComposto,
      bestScoreSoFar: bestScoreRef.current.score > -Infinity ? bestScoreRef.current.score : null,
      bestScoreSens: bestScoreRef.current.sens, explorationSignRef,
    });
    feedbackHistoryRef.current = [...feedbackHistoryRef.current, feedbackKey];
    if (pendingSummary.scoreComposto > bestScoreRef.current.score) bestScoreRef.current = { score: pendingSummary.scoreComposto, sens: pendingSummary.sens };
    const finishedRound = { ...pendingSummary, feedback: feedbackKey };
    setRounds((prev) => [...prev, finishedRound]);
    return nextSens;
  };

  const handleNext = (feedbackKey, overrideSens) => {
    applyFeedback(feedbackKey);
    if (roundIndex + 1 < ROUND_COUNT) {
      setCurrentSens(overrideSens);
      setRoundIndex((i) => i + 1);
      setPendingSummary(null);
      setScreen('round');
    } else {
      setScreen('report');
    }
  };

  const handleFinishEarly = (feedbackKey) => {
    applyFeedback(feedbackKey);
    setScreen('report');
  };

  const handleRestartToStart = () => { setScreen('config'); setRounds([]); setRoundIndex(0); setPendingSummary(null); };
  const handleRepeatTest = () => { resetProgress(); setScreen('calibration'); };

  const bestSoFar = rounds.length ? rounds.reduce((a, b) => (b.points > a.points ? b : a)) : null;

  if (envStatus === 'checking') return null;
  if (envStatus === 'no-pointerlock') return <BlockedScreen icon={MousePointer2} title="Navegador não suportado" message="Seu navegador não suporta Pointer Lock, recurso indispensável para simular a sensibilidade do mouse. Tente uma versão recente de Chrome ou Edge no Windows." />;
  if (envStatus === 'no-mouse') return <BlockedScreen icon={AlertTriangle} title="Dispositivo não suportado" message="O Sensitivity Finder foi feito para uso com mouse. Não foi detectado um ponteiro de precisão neste dispositivo." />;

  if (screen === 'config') return <ConfigScreen config={config} setConfig={setConfig} onStart={handleConfigStart} />;
  if (screen === 'calibration') return <CalibrationScreen onDone={handleCalibrationDone} onSkip={handleCalibrationSkip} />;

  if (screen === 'round') {
    return (
      <RoundScreen
        key={roundIndex}
        roundNumber={roundIndex + 1}
        sens={currentSens}
        dpi={resolved.dpi}
        mYaw={resolved.mYaw}
        mPitch={resolved.mPitch}
        aspect={resolved.aspect}
        displayMode={config.displayMode}
        crosshairConfig={crosshairConfig}
        fireButton={config.fireButton}
        onComplete={handleRoundComplete}
      />
    );
  }

  if (screen === 'feedback' && pendingSummary) {
    return (
      <FeedbackScreenWithSuggestion
        summary={pendingSummary}
        bestSoFar={bestSoFar}
        roundsDoneCount={rounds.length}
        isLastRound={roundIndex + 1 >= ROUND_COUNT}
        dpi={resolved.dpi}
        mYaw={resolved.mYaw}
        initialSens={resolved.initialSens}
        feedbackHistoryRef={feedbackHistoryRef}
        bestScoreRef={bestScoreRef}
        explorationSignRef={explorationSignRef}
        onNext={handleNext}
        onRestart={handleRestartToStart}
        onFinishEarly={handleFinishEarly}
      />
    );
  }

  if (screen === 'report') {
    return <ReportScreen rounds={rounds} config={config} resolved={resolved} calibrationDeviation={calibrationDeviation} onRestart={handleRestartToStart} onRepeat={handleRepeatTest} />;
  }

  return null;
}

// Wrapper que calcula, ao vivo, a sugestão de sensibilidade assim que o
// usuário responde o feedback (sem gravar nada até o clique em avançar) —
// mantém o cálculo do algoritmo num único lugar (`computeNextSensitivity`).
function FeedbackScreenWithSuggestion({ summary, bestSoFar, roundsDoneCount, isLastRound, dpi, mYaw, initialSens, feedbackHistoryRef, bestScoreRef, explorationSignRef, onNext, onRestart, onFinishEarly }) {
  const [answered, setAnswered] = useState(null);
  const [overrideStr, setOverrideStr] = useState('');
  const [confirmingReset, setConfirmingReset] = useState(false);
  const pointsDelta = bestSoFar ? summary.points - bestSoFar.points : 0;
  const canFinishEarly = roundsDoneCount + 1 >= MIN_ROUNDS_TO_FINISH_EARLY && !isLastRound;

  const suggested = useMemo(() => {
    if (!answered) return null;
    const nextSens = computeNextSensitivity({
      currentSens: summary.sens, feedback: answered, roundNumber: summary.roundNumber,
      feedbackHistory: feedbackHistoryRef.current, initialSens,
      currentRoundScore: summary.scoreComposto,
      bestScoreSoFar: bestScoreRef.current.score > -Infinity ? bestScoreRef.current.score : null,
      bestScoreSens: bestScoreRef.current.sens, explorationSignRef,
    });
    return { sens: nextSens, eDPI: calcEDPI(dpi, nextSens), cm360: calcCm360(dpi, nextSens, mYaw) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answered]);

  const finalSens = () => {
    const n = parseDecimalStr(overrideStr);
    return Number.isFinite(n) && n > 0 ? n : suggested.sens;
  };

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-slate-100 flex items-center justify-center p-6">
      <div className="w-full max-w-xl bg-slate-900/60 border border-slate-800 rounded-2xl p-8 space-y-6">
        <div className="text-center space-y-1">
          <p className="text-slate-400 text-sm">Rodada {summary.roundNumber}/{ROUND_COUNT} concluída</p>
          <h2 className="text-xl font-semibold">Como foi essa rodada?</h2>
        </div>

        <div className="grid grid-cols-3 gap-3 font-mono text-sm">
          <div className="bg-slate-800/60 rounded-lg p-3"><p className="text-slate-500 text-xs">Precisão</p><p className="text-lg text-cyan-300">{(summary.precisao * 100).toFixed(0)}%</p></div>
          <div className="bg-slate-800/60 rounded-lg p-3"><p className="text-slate-500 text-xs">Precisão radial</p><p className="text-lg text-cyan-300">{(summary.precisaoRadial * 100).toFixed(0)}%</p></div>
          <div className="bg-slate-800/60 rounded-lg p-3"><p className="text-slate-500 text-xs">Reação mediana</p><p className="text-lg text-cyan-300">{summary.reactionMedian.toFixed(0)}ms</p></div>
          <div className="bg-slate-800/60 rounded-lg p-3"><p className="text-slate-500 text-xs">Pontuação</p><p className="text-lg text-lime-300">{summary.points}</p></div>
          <div className="bg-slate-800/60 rounded-lg p-3 col-span-2">
            <p className="text-slate-500 text-xs flex items-center gap-1"><Trophy size={12} /> vs. melhor rodada</p>
            <p className={`text-lg ${pointsDelta >= 0 ? 'text-lime-300' : 'text-rose-400'}`}>{bestSoFar ? `${pointsDelta >= 0 ? '+' : ''}${pointsDelta}` : '—'}</p>
          </div>
        </div>

        {!answered && (
          <div className="space-y-2">
            <p className="text-sm text-slate-300">Como a sensibilidade pareceu nesta rodada?</p>
            <div className="grid grid-cols-5 gap-2">
              {FEEDBACK_OPTIONS.map((opt) => (
                <button key={opt.key} onClick={() => { setAnswered(opt.key); setOverrideStr(''); }} className="py-2 rounded-lg text-xs sm:text-sm border border-slate-700 hover:border-cyan-500 hover:bg-cyan-500/10 transition-colors">{opt.label}</button>
              ))}
            </div>
          </div>
        )}

        {answered && suggested && (
          <div className="space-y-4">
            <div className="text-center text-sm text-slate-400">Você disse: <span className="text-cyan-300">{FEEDBACK_OPTIONS.find((o) => o.key === answered)?.label}</span></div>
            <div className="bg-cyan-500/10 border border-cyan-500/30 rounded-lg p-4 space-y-2">
              <p className="text-xs text-slate-400">Rodada {summary.roundNumber + 1} — sens <span className="text-cyan-300">{suggested.sens.toFixed(3)}</span> aplicada automaticamente</p>
              <div className="flex flex-wrap gap-x-6 gap-y-1 font-mono text-sm">
                <span>eDPI: <span className="text-cyan-300">{suggested.eDPI.toFixed(0)}</span></span>
                <span>cm/360: <span className="text-cyan-300">{suggested.cm360.toFixed(1)}</span></span>
              </div>
              <div className="flex items-center gap-2 pt-1">
                <span className="text-xs text-slate-400">Override (opcional):</span>
                <input type="text" inputMode="decimal" value={overrideStr} placeholder={suggested.sens.toFixed(3)} onChange={(e) => setOverrideStr(sanitizeDecimalInput(e.target.value))} className="w-24 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs font-mono" />
              </div>
            </div>

            {!confirmingReset ? (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <button onClick={() => setConfirmingReset(true)} className="py-2.5 rounded-xl border border-slate-700 hover:border-slate-500 text-sm text-slate-300">Voltar ao início</button>
                {canFinishEarly && <button onClick={() => onFinishEarly(answered, finalSens())} className="py-2.5 rounded-xl border border-amber-500/40 hover:border-amber-400 text-sm text-amber-300">Encerrar e ver resultado</button>}
                <button onClick={() => onNext(answered, finalSens())} className={`py-2.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold flex items-center justify-center gap-2 ${canFinishEarly ? '' : 'sm:col-span-2'}`}>
                  {isLastRound ? 'Ver relatório final' : 'Próxima rodada'} <ChevronRight size={18} />
                </button>
              </div>
            ) : (
              <div className="bg-rose-500/10 border border-rose-500/30 rounded-lg p-3 text-center space-y-2">
                <p className="text-sm text-rose-300">Tem certeza? Todo o progresso deste teste será perdido.</p>
                <div className="flex justify-center gap-2">
                  <button onClick={() => setConfirmingReset(false)} className="px-4 py-1.5 rounded-lg border border-slate-700 text-sm text-slate-300">Cancelar</button>
                  <button onClick={onRestart} className="px-4 py-1.5 rounded-lg bg-rose-500 hover:bg-rose-400 text-slate-950 text-sm font-semibold">Sim, voltar</button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
