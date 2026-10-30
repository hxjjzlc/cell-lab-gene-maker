'use strict';
/**
 * Cell Lab / Cell Lab: Macro 基因组工具库 —— 单文件、零依赖、可移植
 *
 * 设计约束（见"多平台适配报告"）：
 *   - 只用 Uint8Array + DataView，不碰 Buffer
 *   - 不 require 任何模块（无 fs / path / buffer）
 *   - 文件 IO 全部交给调用方；本文件只处理字节
 *   - Node 下导出 module.exports，其它宿主挂到 globalThis.CellLab
 *
 * .genome 格式（经 4 份真实样本字节级往返验证）：
 *   文件 = Java ObjectOutputStream 外壳 + 裸 primitive 载荷
 *     外壳: AC ED 00 05，随后每 1024 字节一块
 *           满块 0x7A + int32(1024)，尾块 0x77 + 1 字节长度
 *   载荷 = int32 文件版本 + N 个模式段（官方样本 N=127）
 *     段 version=95   → 315 字节
 *     段 version=3055 → 331 字节（末尾多 16 字节扩展）
 */

// ============================================================ 常量

const JAVA_MAGIC = [0xac, 0xed, 0x00, 0x05];
const BLOCK = 1024;
const MODE_V95 = 315;
const MODE_V3055 = 331;
const N_VALUES = 11;
const N_INTS = 11;
const N_FLOATS = 7;
const N_MODES = 127;

/** 细胞类型：索引即文件里 cellType 的值（顺序来自官方 .substrate 基因池顺序，勿重排） */
const CELL_TYPES = [
  { id: 0,  key: 'phagocyte',    cn: '吞噬细胞', en: 'Phagocyte' },
  { id: 1,  key: 'flagellocyte', cn: '鞭毛细胞', en: 'Flagellocyte' },
  { id: 2,  key: 'photocyte',    cn: '光合细胞', en: 'Photocyte' },
  { id: 3,  key: 'devorocyte',   cn: '肉食细胞', en: 'Devorocyte' },
  { id: 4,  key: 'lipocyte',     cn: '脂肪细胞', en: 'Lipocyte' },
  { id: 5,  key: 'keratinocyte', cn: '角质细胞', en: 'Keratinocyte' },
  { id: 6,  key: 'buoyocyte',    cn: '浮力细胞', en: 'Buoyocyte' },
  { id: 7,  key: 'glueocyte',    cn: '粘附细胞', en: 'Glueocyte' },
  { id: 8,  key: 'virocyte',     cn: '病毒细胞', en: 'Virocyte' },
  { id: 9,  key: 'nitrocyte',    cn: '固氮细胞', en: 'Nitrocyte' },
  { id: 10, key: 'stereocyte',   cn: '立体感细胞', en: 'Stereocyte' },
  { id: 11, key: 'senseocyte',   cn: '感觉细胞', en: 'Senseocyte' },
  { id: 12, key: 'myocyte',      cn: '肌肉细胞', en: 'Myocyte' },
  { id: 13, key: 'neurocyte',    cn: '神经细胞', en: 'Neurocyte' },
  { id: 14, key: 'secrocyte',    cn: '分泌细胞', en: 'Secrocyte' },
  { id: 15, key: 'stemocyte',    cn: '干细胞',   en: 'Stemocyte' },
  { id: 16, key: 'gamete',       cn: '配子',     en: 'Gamete' },
  { id: 17, key: 'ciliocyte',    cn: '纤毛细胞', en: 'Ciliocyte' },
];

/**
 * 原版（Cell Lab: Evolution Sandbox，非 Macro）18 种细胞的机制与参数映射。
 * v = 可编程值槽（Value[]），i = 整型槽（int[]），f = 浮点槽（float[]）。
 * 可编程值存归一化系数 b∈[-1,1]，界面值 = b × scale + offset。
 * 依据：官方 Gene.java（kpws/Cell-Lab-open-utilities）+ 官方 wiki + 真实基因样本。
 */
const CELL_MECHANICS = {
  phagocyte: {
    role: '吃营养颗粒', energy: 1.0, cap: 3.6,
    notes: ['每块营养按 10ng/h 吞入', '带膜营养（脂肪细胞尸体）要先被脂肪酶脱膜'],
  },
  flagellocyte: {
    role: '鞭毛推进', energy: null, cap: 3.6,
    v: [[0, '游泳力', 0.5, 0.5]],
    notes: ['推力越大越耗能', '出生时鞭毛被姐妹细胞挡住就当场死', '朝向 = 分裂角 + 子角'],
  },
  photocyte: {
    role: '光合供能', energy: 2.5, cap: 3.6,
    notes: ['产量与表面积成正比', '全游戏最耗能的细胞', '黑暗里只出不进'],
  },
  devorocyte: {
    role: '接触吞噬细胞', energy: null, cap: 3.6,
    notes: ['贴住别的细胞就把对方吸掉', '角质细胞及其直接相连的细胞免疫', '吸脂肪细胞会掉速'],
  },
  lipocyte: {
    role: '储能', energy: 0.03, cap: 21.6,
    notes: ['3.6ng 本体之外还能存 18ng 脂肪', '营养分配按总量上限算，等于 6 倍优先级', '信号物质穿不过脂肪细胞', '死亡掉包膜营养，要脂肪酶才能吃'],
  },
  keratinocyte: {
    role: '护甲', energy: null, cap: 3.6,
    notes: ['免疫：吞噬、病毒、粘连、HCN', '不免疫：蛋白酶、脂肪酶、挤压、信号'],
  },
  buoyocyte: {
    role: '浮沉', energy: null, cap: 3.6,
    v: [[1, '密度', 3, 0]],
    notes: ['密度高于环境才下沉，低于环境上浮（正值下沉、负值上浮）', '值离 0 越远越快'],
  },
  glueocyte: {
    role: '接触粘连', energy: null, cap: 3.6,
    notes: ['碰到无保护细胞就粘上', '自身连接数超过 5 就不再粘', '单格上限 20 条连接'],
  },
  virocyte: {
    role: '感染', energy: null, cap: 3.6,
    i: [[0, '复制来源模式', 127], [1, '被感染者变成', 127]],
    notes: ['只能复制来源模式及其子、孙两代', '指到谱系外的模式不分裂'],
  },
  nitrocyte: {
    role: '固氮', energy: null, cap: 3.6,
    notes: ['自身氮储备恒为 100%', '氮只经粘附连接输送，不靠膜接触', '低氮培养皿里靠它续命'],
  },
  stereocyte: {
    role: '左右气味差（转向）', energy: null, cap: 3.6,
    i: [[2, '输出通道', 4], [3, '气味类型', 6]],
    f: [[0, '输出强度', 60], [1, '红', 1], [2, '绿', 1], [3, '蓝', 1], [4, '颜色阈值', 1.732]],
    notes: ['一侧闻到给正信号，另一侧给负信号', '多种气味会相加'],
  },
  senseocyte: {
    role: '气味浓度', energy: null, cap: 3.6,
    i: [[2, '输出通道', 4], [3, '气味类型', 6]],
    f: [[0, '输出强度', 60], [1, '红', 1], [2, '绿', 1], [3, '蓝', 1], [4, '颜色阈值', 1.732]],
    notes: ['只闻浓度，不分方向'],
  },
  myocyte: {
    role: '肌肉', energy: 0, cap: 3.6,
    v: [[2, '弯曲', 1, 0], [3, '收缩', 0.5, 0], [4, '抬举', 1, 0]],
    notes: ['弯曲正值向右、负值向左', '收缩正值拉、负值推', '抬举把前方抬起、后方压下'],
  },
  neurocyte: {
    role: '信号输出', energy: null, cap: 3.6,
    v: [[7, 'S1 输出', 20, 0], [8, 'S2 输出', 20, 0], [9, 'S3 输出', 20, 0], [10, 'S4 输出', 20, 0]],
    notes: ['四路各自选输入源与算法', '单路最高 320 μmol/L/h', '可输出负值'],
  },
  secrocyte: {
    role: '分泌', energy: null, cap: 3.6,
    i: [[4, '分泌物', 14]],
    f: [[0, '气味强度', 60], [1, '红', 1], [2, '绿', 1], [3, '蓝', 1]],
    notes: ['持续耗氮约 45%/h', '氮储备低于 25% 停止分泌', '7-10 是 +S1..S4，11-14 是 -S1..-S4'],
  },
  stemocyte: {
    role: '分化', energy: null, cap: 3.6,
    v: [[5, '路径1 信号', 1, 0], [6, '路径2 信号', 1, 0]],
    notes: ['路径信号 > 0.5 就变成对应子模式', '0.5h 后才分化，分化重置年龄', '两条都满足时路径1 优先', '能分化时不分裂'],
  },
  gamete: {
    role: '融合生殖', energy: 0.03, cap: 3.6,
    i: [[10, '融合后端粒长度', 5]],
    notes: ['永远不会分裂', '0.5h 后可与配子融合', '较大的一方决定融合后的模式', '融合时两套基因组混合'],
  },
  ciliocyte: {
    role: '纤毛游动', energy: 0.03, cap: 3.6,
    v: [[2, '左侧速度', 1, 0], [4, '右侧速度', 1, 0]],
    notes: ['左右纤毛速度不同就会转向', '这两个槽和肌肉细胞的弯曲/抬举共用'],
  },
};

/** 取某个细胞类型的机制条目（未知类型返回 null） */
function mechanicsOf(cellType) {
  const t = TYPE_BY_ID.get(cellType);
  return t ? (CELL_MECHANICS[t.key] || null) : null;
}

/** 生长树上的类型提示，一行，不解释 */
function modeHint(m) {
  const v = (i, scale, off) => {
    const s = m.values && m.values[i];
    return (s ? (Number(s.b) || 0) : 0) * scale + off;
  };
  const k = (j) => (m.ints && Number.isFinite(m.ints[j])) ? m.ints[j] : 0;
  switch (m.cellType) {
    case 1:  return '推力 ' + fmt(v(0, 0.5, 0.5), 2);
    case 2:  return '需光';
    case 4:  return '上限 21.6ng';
    case 6:  return '密度 ' + fmt(v(1, 3, 0), 2);
    case 8:  return '复制 M' + (k(0) + 1) + '→M' + (k(1) + 1);
    case 10:
    case 11: return 'S' + (k(2) + 1) + ' 输出 ' + fmt(m.floats ? m.floats[0] : 0, 0);
    case 12: return '收缩 ' + fmt(v(3, 0.5, 0), 2) + ' 弯 ' + fmt(v(2, 1, 0), 2);
    case 14: return '分泌 ' + secreteName(k(4));
    case 15: return '分化 M' + m.child1Mode + '/M' + m.child2Mode;
    case 16: return '不分裂·靠融合';
    default: return '';
  }
}

const TYPE_BY_KEY = new Map(CELL_TYPES.map(t => [t.key, t]));
const TYPE_BY_ID = new Map(CELL_TYPES.map(t => [t.id, t]));
const TYPE_ALIASES = new Map();
for (const t of CELL_TYPES) {
  TYPE_ALIASES.set(t.key, t.id);
  TYPE_ALIASES.set(t.cn, t.id);
  TYPE_ALIASES.set(t.en.toLowerCase(), t.id);
}

const VAL = {
  swimForce: 0, density: 1, muscleBend: 2, muscleContract: 3, muscleLift: 4,
  stemThreshold1: 5, stemThreshold2: 6, signalOut0: 7,
};
const INT = {
  virusFrom: 0, virusTo: 1, smellSource: 2, smellType: 3, secreteType: 4,
  signalTarget0: 5, maxConnections: 9, telomerase: 10,
};
const FLOAT = {
  smellAmount: 0, smellRed: 1, smellGreen: 2, smellBlue: 3,
  smellThreshold: 4, adhesinLength: 5, cytoskeleton: 6,
};

const INPUTS = [
  { id: 0, key: 's1', cn: 'S1 浓度' }, { id: 1, key: 's2', cn: 'S2 浓度' },
  { id: 2, key: 's3', cn: 'S3 浓度' }, { id: 3, key: 's4', cn: 'S4 浓度' },
  { id: 4, key: 'mass', cn: '细胞质量' }, { id: 5, key: 'age', cn: '细胞年龄' },
  { id: 6, key: 'nh3', cn: '氮储量' }, { id: 7, key: 'connections', cn: '连接数' },
];

const SECRETE_TYPES = [
  { id: 0, key: 'food', cn: '营养' }, { id: 1, key: 'cyanide', cn: '氰化物' },
  { id: 2, key: 'defensin', cn: '防御素' }, { id: 3, key: 'protease', cn: '蛋白酶' },
  { id: 4, key: 'foodSmell', cn: '营养气味' }, { id: 5, key: 'lightSmell', cn: '光照气味' },
  { id: 6, key: 'wallSmell', cn: '细胞壁气味' },
];

function secreteName(id) {
  const t = SECRETE_TYPES.find(x => x.id === id);
  if (t) return t.cn;
  if (id >= 7 && id <= 10) return '+S' + (id - 6);
  if (id >= 11 && id <= 14) return '-S' + (id - 10);
  return '类型 ' + id;
}

const DEG = 180 / Math.PI;

// ============================================================ 字节读写

/**
 * 把各种输入归一成 Uint8Array。
 * 宿主可能给 ArrayBuffer / 普通数组 / 别的 TypedArray / 带缓冲的视图。
 */
function toBytes(input) {
  if (input == null) throw new Error('需要字节数据，收到 ' + input);
  // 用 toString 标签判断，避免跨 realm 时 instanceof 失效（嵌入宿主常见）
  const tag = Object.prototype.toString.call(input);
  if (tag === '[object Uint8Array]' || tag === '[object Uint8ClampedArray]') return input;
  if (tag === '[object ArrayBuffer]' || tag === '[object SharedArrayBuffer]') return new Uint8Array(input);
  if (typeof ArrayBuffer !== 'undefined' && typeof ArrayBuffer.isView === 'function' && ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (Array.isArray(input) || (typeof input === 'object' && typeof input.length === 'number')) {
    return Uint8Array.from(input);
  }
  throw new Error('无法识别的字节数据类型: ' + tag);
}

/** 顺序读取器（大端） */
class Reader {
  constructor(bytes) {
    this.buf = bytes;
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.p = 0;
  }
  need(n) {
    if (this.p + n > this.buf.length) throw new Error(`数据在偏移 ${this.p} 处提前结束（还需 ${n} 字节）`);
  }
  i32() { this.need(4); const v = this.dv.getInt32(this.p, false); this.p += 4; return v; }
  i16() { this.need(2); const v = this.dv.getInt16(this.p, false); this.p += 2; return v; }
  f32() { this.need(4); const v = this.dv.getFloat32(this.p, false); this.p += 4; return v; }
  byte() { this.need(1); return this.buf[this.p++]; }
  bool() { return this.byte() !== 0; }
  raw(n) { this.need(n); const s = this.buf.subarray(this.p, this.p + n); this.p += n; return s; }
}

/** 定长写入器（大端） */
class Writer {
  constructor(size) {
    this.buf = new Uint8Array(size);
    this.dv = new DataView(this.buf.buffer);
    this.p = 0;
  }
  i32(v) { this.dv.setInt32(this.p, v | 0, false); this.p += 4; }
  i16(v) { this.dv.setInt16(this.p, v | 0, false); this.p += 2; }
  f32(v) { this.dv.setFloat32(this.p, Number(v) || 0, false); this.p += 4; }
  byte(v) { this.buf[this.p++] = v & 0xff; }
  bool(v) { this.buf[this.p++] = v ? 1 : 0; }
  raw(arr) { this.buf.set(arr, this.p); this.p += arr.length; }
}

// ============================================================ Macro 新版容器（v3145+）

// ---- 纯 JS raw deflate 解压（RFC1951），不依赖 zlib ----
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function inflateRaw(src) {
  let pos = 0, bitBuf = 0, bitCnt = 0;
  const out = [];
  const bits = (n) => {
    while (bitCnt < n) {
      if (pos >= src.length) throw new Error('deflate 数据提前结束');
      bitBuf |= src[pos++] << bitCnt;
      bitCnt += 8;
    }
    const v = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n;
    bitCnt -= n;
    return v;
  };
  const huff = (lengths) => {
    const maxLen = lengths.reduce((a, b) => Math.max(a, b), 0);
    const counts = new Array(maxLen + 1).fill(0);
    for (const l of lengths) if (l) counts[l]++;
    let left = 1;
    for (let len = 1; len <= maxLen; len++) {
      left = (left << 1) - counts[len];
      if (left < 0) throw new Error('Huffman 码表超订');
    }
    const offs = new Array(maxLen + 2).fill(0);
    for (let len = 1; len <= maxLen; len++) offs[len + 1] = offs[len] + counts[len];
    const symbols = new Array(lengths.length);
    for (let i = 0; i < lengths.length; i++) if (lengths[i]) symbols[offs[lengths[i]]++] = i;
    return { counts, symbols, maxLen };
  };
  const decodeSym = (h) => {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len <= h.maxLen; len++) {
      code |= bits(1);
      const count = h.counts[len];
      if (code - first < count) return h.symbols[index + (code - first)];
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new Error('Huffman 解码失败');
  };

  let last = 0;
  while (!last) {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      bitBuf = 0; bitCnt = 0;
      const len = src[pos] | (src[pos + 1] << 8);
      pos += 4;
      for (let i = 0; i < len; i++) out.push(src[pos++]);
    } else if (type === 1 || type === 2) {
      let lit, dist;
      if (type === 1) {
        const ll = new Array(288);
        for (let i = 0; i < 144; i++) ll[i] = 8;
        for (let i = 144; i < 256; i++) ll[i] = 9;
        for (let i = 256; i < 280; i++) ll[i] = 7;
        for (let i = 280; i < 288; i++) ll[i] = 8;
        lit = huff(ll);
        dist = huff(new Array(30).fill(5));
      } else {
        const hlit = bits(5) + 257;
        const hdist = bits(5) + 1;
        const hclen = bits(4) + 4;
        const clen = new Array(19).fill(0);
        for (let i = 0; i < hclen; i++) clen[CLEN_ORDER[i]] = bits(3);
        const ch = huff(clen);
        const lengths = [];
        while (lengths.length < hlit + hdist) {
          const sym = decodeSym(ch);
          if (sym < 16) lengths.push(sym);
          else if (sym === 16) {
            const prev = lengths[lengths.length - 1];
            const rep = 3 + bits(2);
            for (let i = 0; i < rep; i++) lengths.push(prev);
          } else if (sym === 17) {
            const rep = 3 + bits(3);
            for (let i = 0; i < rep; i++) lengths.push(0);
          } else {
            const rep = 11 + bits(7);
            for (let i = 0; i < rep; i++) lengths.push(0);
          }
        }
        lit = huff(lengths.slice(0, hlit));
        dist = huff(lengths.slice(hlit));
      }
      for (;;) {
        const sym = decodeSym(lit);
        if (sym < 256) { out.push(sym); continue; }
        if (sym === 256) break;
        const li = sym - 257;
        const len = LEN_BASE[li] + bits(LEN_EXTRA[li]);
        const ds = decodeSym(dist);
        const d = DIST_BASE[ds] + bits(DIST_EXTRA[ds]);
        const start = out.length - d;
        if (start < 0) throw new Error('deflate 回溯越界');
        for (let i = 0; i < len; i++) out.push(out[start + i]);
      }
    } else {
      throw new Error('deflate 块类型 3 非法');
    }
  }
  return Uint8Array.from(out);
}

// ---- CRC32 / ZIP ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(u8) {
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function isZip(b) {
  return b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}

function zipRead(b) {
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 66000); i--) {
    if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x05 && b[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP 缺少中央目录结尾');
  const count = b[eocd + 10] | (b[eocd + 11] << 8);
  let p = (b[eocd + 16] | (b[eocd + 17] << 8) | (b[eocd + 18] << 16) | (b[eocd + 19] << 24)) >>> 0;
  const files = [];
  for (let n = 0; n < count; n++) {
    if (b[p] !== 0x50 || b[p + 1] !== 0x4b || b[p + 2] !== 0x01 || b[p + 3] !== 0x02) throw new Error('中央目录项损坏');
    const method = b[p + 10] | (b[p + 11] << 8);
    const crc = (b[p + 16] | (b[p + 17] << 8) | (b[p + 18] << 16) | (b[p + 19] << 24)) >>> 0;
    const csize = (b[p + 20] | (b[p + 21] << 8) | (b[p + 22] << 16) | (b[p + 23] << 24)) >>> 0;
    const usize = (b[p + 24] | (b[p + 25] << 8) | (b[p + 26] << 16) | (b[p + 27] << 24)) >>> 0;
    const nameLen = b[p + 28] | (b[p + 29] << 8);
    const extraLen = b[p + 30] | (b[p + 31] << 8);
    const cmtLen = b[p + 32] | (b[p + 33] << 8);
    const localOff = (b[p + 42] | (b[p + 43] << 8) | (b[p + 44] << 16) | (b[p + 45] << 24)) >>> 0;
    const name = utf8Decode(b.subarray(p + 46, p + 46 + nameLen));
    const lNameLen = b[localOff + 26] | (b[localOff + 27] << 8);
    const lExtraLen = b[localOff + 28] | (b[localOff + 29] << 8);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = b.subarray(dataStart, dataStart + csize);
    const data = method === 0 ? raw : method === 8 ? inflateRaw(raw) : (() => { throw new Error(`不支持的 ZIP 压缩方式 ${method}`); })();
    files.push({ name, data, method, crc, usize });
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return files;
}

/** 全部以 stored 方式写出，任何解压器都能读，且不依赖 zlib */
function zipWriteStored(files) {
  const parts = [], central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;
  for (const f of files) {
    const nameBuf = utf8Encode(f.name);
    const data = f.data;
    const crc = crc32(data);
    const lh = new Uint8Array(30 + nameBuf.length);
    const dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0x0800, true);
    dv.setUint16(8, 0, true);
    dv.setUint16(10, dosTime, true);
    dv.setUint16(12, dosDate, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, data.length, true);
    dv.setUint32(22, data.length, true);
    dv.setUint16(26, nameBuf.length, true);
    dv.setUint16(28, 0, true);
    lh.set(nameBuf, 30);
    parts.push(lh, data);
    const ch = new Uint8Array(46 + nameBuf.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBuf.length, true);
    cv.setUint32(42, offset, true);
    ch.set(nameBuf, 46);
    central.push(ch);
    offset += lh.length + data.length;
  }
  let cenSize = 0;
  for (const c of central) cenSize += c.length;
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cenSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cenSize + 22);
  let w = 0;
  for (const p of parts) { out.set(p, w); w += p.length; }
  for (const c of central) { out.set(c, w); w += c.length; }
  out.set(eocd, w);
  return out;
}

function utf8Encode(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

function utf8Decode(u8) {
  let s = '';
  for (let i = 0; i < u8.length;) {
    const c = u8[i++];
    if (c < 0x80) s += String.fromCharCode(c);
    else if (c < 0xe0) s += String.fromCharCode(((c & 31) << 6) | (u8[i++] & 63));
    else s += String.fromCharCode(((c & 15) << 12) | ((u8[i++] & 63) << 6) | (u8[i++] & 63));
  }
  return s;
}

// ---- 新版模式段 ----
// 段布局（v3145 / v3169 一致，由反编译 classes.dex 的 Gene.o() 得出，并用 86 个真实段验证）：
//   0..90    标量区（91 字节）
//   91..362  Value[17]  × 16   { int16 input, int16 form, float a, b, c }
//   363..426 int[16]    × 4    maxConnections 等整型参数
//   427..510 float[21]  × 4    adhesinLength / cytoskeleton / 嗅觉等
//   511..段尾 I0 区（10 个 65 字节的细胞类型参数块）+ 收尾，跨段一致率 99%，原样保留
const M_SCALAR_END = 91;
const M_VALUES_AT = 91, M_VALUES_N = 17;
const M_INTS_AT = 363, M_INTS_N = 16;
const M_FLOATS_AT = 427, M_FLOATS_N = 21;
const M_KEEP_FROM = 511;

const MODERN_SEG_MIN = 300;
const MODERN_SEG_MAX = 8192;
const MODERN_TAIL_MAX = 512;

/** 文件头 = int32 版本 + int32 模式数；用「每段开头都等于版本号」定位段长 */
function detectModernLayout(pl, cnt, ver) {
  const dv = new DataView(pl.buffer, pl.byteOffset, pl.byteLength);
  const body = pl.length - 8;
  const cands = [];
  for (let s = MODERN_SEG_MIN; s <= MODERN_SEG_MAX; s++) {
    const tail = body - s * cnt;
    if (tail < 0 || tail > MODERN_TAIL_MAX) continue;
    let ok = true;
    for (let i = 0; i < cnt; i++) {
      if (dv.getInt32(8 + i * s, false) !== ver) { ok = false; break; }
    }
    if (ok) cands.push({ seg: s, tail });
  }
  if (!cands.length) return null;
  cands.sort((a, b) => a.tail - b.tail);
  return cands[0];
}

function decodeModernMode(pl, o, seg) {
  const dv = new DataView(pl.buffer, pl.byteOffset, pl.byteLength);
  const i32 = (x) => dv.getInt32(x, false);
  const i16 = (x) => dv.getInt16(x, false);
  const f32 = (x) => dv.getFloat32(x, false);
  const u8 = (x) => pl[x];

  const m = {
    version: i32(o),
    color: [f32(o + 4), f32(o + 8), f32(o + 12)],
    _rawSplitMass: f32(o + 16),
    splitRatio: f32(o + 20),
    _rawAngles: [f32(o + 24), f32(o + 28), f32(o + 32)],
    priority: f32(o + 36),
    child1Mode: i32(o + 40) + 1,
    child2Mode: i32(o + 44) + 1,
    makeAdhesin: u8(o + 48) !== 0,
    child1KeepAdhesin: u8(o + 49) !== 0,
    child2KeepAdhesin: u8(o + 50) !== 0,
    cellType: i32(o + 51),
    reserved: i32(o + 55),
    /** 59..65 七个布尔；[1] 已确认为 isInitial，其余语义待定，按位保留 */
    flags7: [0, 1, 2, 3, 4, 5, 6].map(k => u8(o + 59 + k)),
    ints3: [i32(o + 66), i32(o + 70), i32(o + 74)],
    flags5: [0, 1, 2, 3, 4].map(k => u8(o + 78 + k)),
    floats2: [f32(o + 83), f32(o + 87)],
    values: [],
    ints: [],
    floats: [],
    _modern: true,
    _seg: seg,
    _raw: Uint8Array.from(pl.subarray(o, o + seg)),
  };

  for (let i = 0; i < M_VALUES_N; i++) {
    const b = o + M_VALUES_AT + i * 16;
    m.values.push({ input: i16(b), form: i16(b + 2), a: f32(b + 4), b: f32(b + 8), c: f32(b + 12) });
  }
  for (let i = 0; i < M_INTS_N; i++) m.ints.push(i32(o + M_INTS_AT + i * 4));
  for (let i = 0; i < M_FLOATS_N; i++) m.floats.push(f32(o + M_FLOATS_AT + i * 4));

  m.splitMass = m._rawSplitMass * 10;
  m.splitAngle = m._rawAngles[0] * DEG;
  m.child1Angle = m._rawAngles[1] * DEG;
  m.child2Angle = m._rawAngles[2] * DEG;
  m.isInitial = m.flags7[1] !== 0;
  m.stayAlive = m.flags7[0] !== 0;     // 样本里恒真，语义未定，只作显示
  m.mirror1 = m.flags7[2] !== 0;
  m.mirror2 = m.flags7[3] !== 0;
  m.adhesinStiffness = m.floats2[0];
  // 最大连接数：ints[7] 存界面值（样本里 20）；为 0 的模式视作默认 20，但不回写
  m.maxConnections = (m.ints[7] > 0 && m.ints[7] <= 64) ? m.ints[7] : 20;
  m._rawMaxConn = m.ints[7];

  const t = TYPE_BY_ID.get(m.cellType);
  m.type = t ? t.key : `type${m.cellType}`;
  m.typeCn = t ? t.cn : `类型 ${m.cellType}（Macro 新增）`;
  return m;
}

function encodeModernMode(w, m, seg, fallback) {
  const src = (m._raw && m._raw.length === seg) ? m._raw : fallback;
  if (!src) throw new Error(`模式 M${(m.__idx || 0) + 1} 缺少 ${seg} 字节模板段`);
  const raw = Uint8Array.from(src);
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const setI32 = (x, v) => dv.setInt32(x, v | 0, false);
  const setF32 = (x, v) => dv.setFloat32(x, Number(v) || 0, false);

  setI32(0, m.version || 3169);
  setF32(4, m.color[0]); setF32(8, m.color[1]); setF32(12, m.color[2]);
  setF32(16, pickRaw(m._rawSplitMass, m.splitMass / 10));
  setF32(20, m.splitRatio);
  const ra = m._rawAngles || [];
  setF32(24, pickRaw(ra[0], m.splitAngle / DEG));
  setF32(28, pickRaw(ra[1], m.child1Angle / DEG));
  setF32(32, pickRaw(ra[2], m.child2Angle / DEG));
  setF32(36, m.priority);
  setI32(40, m.child1Mode - 1);
  setI32(44, m.child2Mode - 1);
  raw[48] = m.makeAdhesin ? 1 : 0;
  raw[49] = m.child1KeepAdhesin ? 1 : 0;
  raw[50] = m.child2KeepAdhesin ? 1 : 0;
  setI32(51, m.cellType);
  setI32(55, m.reserved | 0);

  if (Array.isArray(m.flags7)) for (let k = 0; k < 7; k++) raw[59 + k] = m.flags7[k] ? 1 : 0;
  raw[60] = m.isInitial ? 1 : 0;
  if (Array.isArray(m.ints3)) for (let k = 0; k < 3; k++) setI32(66 + k * 4, m.ints3[k]);
  if (Array.isArray(m.flags5)) for (let k = 0; k < 5; k++) raw[78 + k] = m.flags5[k] ? 1 : 0;
  if (Array.isArray(m.floats2)) { setF32(83, m.floats2[0]); setF32(87, m.floats2[1]); }
  else { setF32(83, m.adhesinStiffness); }

  if (Array.isArray(m.values)) {
    for (let i = 0; i < M_VALUES_N; i++) {
      const v = m.values[i];
      if (!v) continue;
      const b = M_VALUES_AT + i * 16;
      dv.setInt16(b, v.input | 0, false);
      dv.setInt16(b + 2, v.form | 0, false);
      setF32(b + 4, v.a); setF32(b + 8, v.b); setF32(b + 12, v.c);
    }
  }
  if (Array.isArray(m.ints)) {
    for (let i = 0; i < M_INTS_N; i++) if (m.ints[i] !== undefined) setI32(M_INTS_AT + i * 4, m.ints[i]);
  }
  if (Array.isArray(m.floats)) {
    for (let i = 0; i < M_FLOATS_N; i++) if (m.floats[i] !== undefined) setF32(M_FLOATS_AT + i * 4, m.floats[i]);
  }
  w.raw(raw);
}

/** 新版 save.bin：int32 版本 + int32 模式数 + N 段 + 尾部 */
function decodeModernSave(saveBytes) {
  const pl = unwrap(saveBytes);
  if (pl.length < 12) throw new Error('save.bin 太短');
  const dv = new DataView(pl.buffer, pl.byteOffset, pl.byteLength);
  const fileVersion = dv.getInt32(0, false);
  const count = dv.getInt32(4, false);
  if (count <= 0 || count > 512) throw new Error(`模式数异常: ${count}`);
  const lay = detectModernLayout(pl, count, fileVersion);
  if (!lay) throw new Error(`无法定位段长（版本 ${fileVersion}，${count} 段，载荷 ${pl.length} 字节）`);
  const modes = [];
  for (let i = 0; i < count; i++) modes.push(decodeModernMode(pl, 8 + i * lay.seg, lay.seg));
  const tailStart = 8 + count * lay.seg;
  return {
    container: 'zip',
    fileVersion,
    modeSize: lay.seg,
    count,
    modes,
    tail: Uint8Array.from(pl.subarray(tailStart, tailStart + lay.tail)),
    _tailLen: lay.tail,
  };
}

function encodeModernSave(model) {
  const modes = model.modes;
  const seg = model.modeSize || 1212;
  const ver = model.fileVersion || 3169;
  const tail = model.tail && model.tail.length ? model.tail : MODERN_DEFAULT_TAIL;
  const pl = new Uint8Array(8 + modes.length * seg + tail.length);
  const dv = new DataView(pl.buffer);
  dv.setInt32(0, ver, false);
  dv.setInt32(4, modes.length, false);
  const chunks = [];
  const w = { p: 8, buf: pl, raw(a) { pl.set(a, this.p); this.p += a.length; } };
  modes.forEach((m, i) => {
    m.__idx = i;
    encodeModernMode(w, m, seg, model.defaultSegment);
  });
  pl.set(tail, 8 + modes.length * seg);
  return wrap(pl);
}


/** 1×1 透明 PNG，给没有缩略图的生成文件兜底（游戏缺文件可能不显示预览） */
const PLACEHOLDER_PNG = base64Decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==');

/** 新版 save.bin 末尾 52 字节（int32 16 + 16×{01,00,00}），取自真实 v3169 样本 */
const MODERN_DEFAULT_TAIL = Uint8Array.from([0,0,0,16,1,0,0,1,0,0,1,0,0,1,0,0,1,0,0,1,0,0,1,0,0,1,0,0,1,0,0,1,0,0,1,0,0,1,0,0,1,0,0,1,0,0,1,0,0,1,0,0]);

/** 新版模式段长度：v3169 为 1212 字节 */
const MODERN_SEG = 1212;

/**
 * 各类细胞在 v3169 下的模板段（base64，1212 字节/段）。
 * 来源：真实游戏导出的「鱼 可繁殖」「！？虫虫？！」两份样本，每类取首个出现段。
 * 生成时以它为底，只覆盖段首 67 字节，其余扩展区原样保留，
 * 保证写出的每个模式在游戏里都是合法数据。
 */
const MODERN_TEMPLATES = {
  0: 'AAAMYT8AAAA/QAAAP4AAAD61jiE+////AAAAAAAAAAAAAAAAPczMzQAAABEAAAAAAQEAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAQgwAAAAAAAAAAAAAviqqrAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC/gAAAAAAAAAAAAAAAAAAAP4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAEAAAAAAAAAHgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADwj1woAAAAAP4AAAEFwAAAAAAAAAAAAAAAAAAAAAAAAPCPXCgAAAAAAAAAAAAAAAAAAAAA8I9cKP4AAAD+AAAA/gAAAAAAAAAAAAAAAAAAAAAYAAAAAAAAAAAAAAAAAAAAAAAYAAAAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYAAAAGAAAAAAAAAAAAAAAABgAAAAAAAAAAAAAAAAAAAAAABgAAAAYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgAAAAYAAAAAAAAAAAAAAAAGAAAAAAAAAAAAAAAAAAAAAAAGAAAABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAAAABgAAAAAAAAAAAAAAAAYAAAAAAAAAAAAAAAAAAAAAAAYAAAAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYAAAAGAAAAAAAAAAAAAAAABgAAAAAAAAAAAAAAAAAAAAAABgAAAAYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgAAAAYAAAAAAAAAAAAAAAAGAAAAAAAAAAAAAAAAAAAAAAAGAAAABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAAAABgAAAAAAAAAAAAAAP4AAAD+AAAAAAAAAAAAAAAABAQAAAAAAAAAAAAAAAAAAPwAAAAEAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEBAQAAAAAAAT4AAAAA/////wG5QQLQx5mYHjioERew1MKmAAAAAAAAABIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAL+AAAAAAAAA',
  1: 'AAAMYT9AAAA/gAAAP4AAAD68AaM+////AAAAAAAAAABASQ/bQSAAAAAAAAMAAAADAQEBAAAAAQAAAAABAAAAAAEAAAAAAAAAAAAAAAABAAAAAAAAAAAAQgwAAAADAAFAExJvvt87ZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC/gAAAAAAAAAAAAAAAAAAAP4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAABQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADwj1woAAAAAP4AAAEFwAAAAAAAAAAAAAAAAAAAAAAAAPCPXCgAAAAAAAAAAAAAAAAAAAAA8I9cKP4AAAD+AAAA/gAAAAAAAAAAAAAAAAAAAAAYAAAAAAAAAAAAAAAAAAAAAAAYAAAAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYAAAAGAAAAAAAAAAAAAAAABgAAAAAAAAAAAAAAAAAAAAAABgAAAAYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgAAAAYAAAAAAAAAAAAAAAAGAAAAAAAAAAAAAAAAAAAAAAAGAAAABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAAAABgAAAAAAAAAAAAAAAAYAAAAAAAAAAAAAAAAAAAAAAAYAAAAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYAAAAGAAAAAAAAAAAAAAAABgAAAAAAAAAAAAAAAAAAAAAABgAAAAYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgAAAAYAAAAAAAAAAAAAAAAGAAAAAAAAAAAAAAAAAAAAAAAGAAAABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAAAABgAAAAAAAAAAAAAAP4AAAD+AAAAAAAAAAwAAAAMBAQAAAAAAAEBJD9sAAAAAPwAAAAEAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEBAQAAAAAAAT4AAAAA/////wG5QQLQx5mYHjioERew1MKmAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAL+AAAAAAAAA',
  2: 'AAAMYT+AAAA/gAAAP4AAAD68AaM+////AAAAAAAAAAAAAAAAQSAAAAAAAAAAAAAAAQEBAAAAAgAAAAABAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAQgwAAAAAAAAAAAAAviqqrAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC/gAAAAAAAAAAAAAAAAAAAP4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAATAAAAAAAAABQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADwj1woAAAAAP4AAAEFwAAAAAAAAAAAAAAAAAAAAAAAAPCPXCgAAAAAAAAAAAAAAAAAAAAA8I9cKP4AAAD+AAAA/gAAAAAAAAAAAAAAAAAAAAAYAAAAAAAAAAAAAAAAAAAAAAAYAAAAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYAAAAGAAAAAAAAAAAAAAAABgAAAAAAAAAAAAAAAAAAAAAABgAAAAYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgAAAAYAAAAAAAAAAAAAAAAGAAAAAAAAAAAAAAAAAAAAAAAGAAAABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAAAABgAAAAAAAAAAAAAAAAYAAAAAAAAAAAAAAAAAAAAAAAYAAAAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYAAAAGAAAAAAAAAAAAAAAABgAAAAAAAAAAAAAAAAAAAAAABgAAAAYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgAAAAYAAAAAAAAAAAAAAAAGAAAAAAAAAAAAAAAAAAAAAAAGAAAABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAAAABgAAAAAAAAAAAAAAP4AAAD+AAAAAAAAAAAAAAAABAQAAAAAAAAAAAAAAAAAAPwAAAAEAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEBAQAAAAAAAT4AAAAA/////wG5QQLQx5mYHjioERew1MKmAAAAAAAAAB0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAL+AAAAAAAAA',
  3: 'AAAMYT9M0bc/GY6ZPBPIOj68AaM/AAAAAAAAAAAAAAAAAAAAP4AAAAAAABkAAAAZAQEBAAAAAwAAAAABAAAAAAAAAAAAAAAAAAAAAAABAAABAAAAAAAAAAAAAAAAAAAAAAAAviqqrAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAL+AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP4AAAAAAAAAAAAAZAAAAGQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAATAAAAAAAAABQAAAAAAAAAGQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADwj1woAAAAAP4AAAEHwAAAAAAAAAAAAAAAAAAAAAAAAPCPXCgAAAAAAAAAAAAAAAAAAAAA8I9cKP4AAAD+AAAA/gAAAAAAAAAAAAAAAAAAAAAYAAAAAAAAAAAAAAAAAAAAAAAYAAAAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYAAAAGAAAAAAAAAAAAAAAABgAAAAAAAAAAAAAAAAAAAAAABgAAAAYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgAAAAYAAAAAAAAAAAAAAAAGAAAAAAAAAAAAAAAAAAAAAAAGAAAABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAAAABgAAAAAAAAAAAAAAAAYAAAAAAAAAAAAAAAAAAAAAAAYAAAAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYAAAAGAAAAAAAAAAAAAAAABgAAAAAAAAAAAAAAAAAAAAAABgAAAAYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgAAAAYAAAAAAAAAAAAAAAAGAAAAAAAAAAAAAAAAAAAAAAAGAAAABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAAAABgAAAAAAAAAAAAAAP4AAAD+AAAAAAAAAAAAAAAABAQAAAAAAAAAAAAAAAAAAPwAAAAEAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEBAQAAAAAAAD4AAAAA/////wHANWAnPCi4vrgE2bptMNI+AAAAAAAAABoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAL+AAAAAAAAA',
  4: 'AAAMYT3g4OE/JqanP0XFxj+cNg89zMzNP0kP2wAAAAAAAAAAQSAAAAAAAAEAAAACAQAAAAAABAAAAAABAQAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAQgwAAAAAAAAAAAAAviqqrAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC/gAAAAAAAAAAAAAAAAAAAP4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAATAAAAAAAAABQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADwj1woAAAAAP4AAAEFwAAAAAAAAAAAAAAAAAAAAAAAAPCPXCgAAAAAAAAAAAAAAAAAAAAA8I9cKP4AAAD+AAAA/gAAAAAAAAAAAAAAAAAAAAAYAAAAAAAAAAAAAAAAAAAAAAAYAAAAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYAAAAGAAAAAAAAAAAAAAAABgAAAAAAAAAAAAAAAAAAAAAABgAAAAYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgAAAAYAAAAAAAAAAAAAAAAGAAAAAAAAAAAAAAAAAAAAAAAGAAAABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAAAABgAAAAAAAAAAAAAAAAYAAAAAAAAAAAAAAAAAAAAAAAYAAAAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYAAAAGAAAAAAAAAAAAAAAABgAAAAAAAAAAAAAAAAAAAAAABgAAAAYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgAAAAYAAAAAAAAAAAAAAAAGAAAAAAAAAAAAAAAAAAAAAAAGAAAABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAAAABgAAAAAAAAAAAAAAP4AAAD+AAAAAAAAAAQAAAAIBAQAAAAAAAAAAAAAAAAAAPwAAAAEAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEBAQAAAAAAAT4AAAAA/////wG5QQLQx5mYHjioERew1MKmAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAL+AAAAAAAAA',
  5: 'AAAMYT9lK+c9a2yrPuJGBT68AaM/AAAAAAAAAAAAAAAAAAAAP4AAAAAAABcAAAAXAQEBAAAABQAAAAABAAAAAAAAAAAAAAAAAAAAAAABAAABAAAAAAAAAAAAAAAAAAAAAAAAviqqrAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAL+AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP4AAAAAAAAAAAAAXAAAAFwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAATAAAAAAAAABQAAAAAAAAAFwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADwj1woAAAAAP4AAAEHwAAAAAAAAAAAAAAAAAAAAAAAAPCPXCgAAAAAAAAAAAAAAAAAAAAA8I9cKP4AAAD+AAAA/gAAAAAAAAAAAAAAAAAAAAAYAAAAAAAAAAAAAAAAAAAAAAAYAAAAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYAAAAGAAAAAAAAAAAAAAAABgAAAAAAAAAAAAAAAAAAAAAABgAAAAYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgAAAAYAAAAAAAAAAAAAAAAGAAAAAAAAAAAAAAAAAAAAAAAGAAAABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAAAABgAAAAAAAAAAAAAAAAYAAAAAAAAAAAAAAAAAAAAAAAYAAAAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYAAAAGAAAAAAAAAAAAAAAABgAAAAAAAAAAAAAAAAAAAAAABgAAAAYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgAAAAYAAAAAAAAAAAAAAAAGAAAAAAAAAAAAAAAAAAAAAAAGAAAABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAAAABgAAAAAAAAAAAAAAP4AAAD+AAAAAAAAAAAAAAAABAQAAAAAAAAAAAAAAAAAAPwAAAAEAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEBAQAAAAAAAD4AAAAA/////wHANWAnPCi4vrgE2bptMNI+AAAAAAAAABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAL+AAAAAAAAA',
  7: 'AAAMYT6AAAA/AAAAP4AAAD2Etd09zMzNP6eNNgAAAABAnyyNQSAAAAAAAAcAAAALAQEBAAAABwAAAAABAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAQgwAAAAAAAAAAAAAviqqrAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC/gAAAAAAAAAAAAAAAAAAAP4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAATAAAAAAAAABQAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADwj1woAAAAAP4AAAEFwAAAAAAAAAAAAAAAAAAAAAAAAPCPXCgAAAAAAAAAAAAAAAAAAAAA8I9cKP4AAAD+AAAA/gAAAAAAAAAAAAAAAAAAAAAYAAAAAAAAAAAAAAAAAAAAAAAYAAAAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYAAAAGAAAAAAAAAAAAAAAABgAAAAAAAAAAAAAAAAAAAAAABgAAAAYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgAAAAYAAAAAAAAAAAAAAAAGAAAAAAAAAAAAAAAAAAAAAAAGAAAABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAAAABgAAAAAAAAAAAAAAAAYAAAAAAAAAAAAAAAAAAAAAAAYAAAAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYAAAAGAAAAAAAAAAAAAAAABgAAAAAAAAAAAAAAAAAAAAAABgAAAAYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgAAAAYAAAAAAAAAAAAAAAAGAAAAAAAAAAAAAAAAAAAAAAAGAAAABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAAAABgAAAAAAAAAAAAAAP4AAAD+AAAAAAAAABwAAAAsBAQAAAAAAAECfLI0AAAAAPwAAAAEAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEBAQAAAAAAAT4AAAAA/////wG5QQLQx5mYHjioERew1MKmAAAAAAAAAAoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAL+AAAAAAAAA',
  12: 'AAAMYT8AAAA/QAAAP4AAAD68AaM+////AAAAAAAAAAAAAAAAP4AAAAAAAAAAAAAAAQEBAAAADAAAAAABAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAQgwAAAAAAAAAAAAAviqqrAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMAAT/CDEoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC/gAAAAAAAAAAAAAAAAAAAP4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAATAAAAAAAAABQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADwj1woAAAAAP4AAAEGMAAAAAAAAAAAAAAAAAAAAAAAAPCPXCgAAAAAAAAAAAAAAAAAAAAA8I9cKP4AAAD+AAAA/gAAAAAAAAAAAAAAAAAAAAAYAAAAAAAAAAAAAAAAAAAAAAAYAAAAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYAAAAGAAAAAAAAAAAAAAAABgAAAAAAAAAAAAAAAAAAAAAABgAAAAYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgAAAAYAAAAAAAAAAAAAAAAGAAAAAAAAAAAAAAAAAAAAAAAGAAAABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAAAABgAAAAAAAAAAAAAAAAYAAAAAAAAAAAAAAAAAAAAAAAYAAAAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYAAAAGAAAAAAAAAAAAAAAABgAAAAAAAAAAAAAAAAAAAAAABgAAAAYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgAAAAYAAAAAAAAAAAAAAAAGAAAAAAAAAAAAAAAAAAAAAAAGAAAABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAAAABgAAAAAAAAAAAAAAP4AAAD+AAAAAAAAAAAAAAAABAQAAAAAAAAAAAAAAAAAAPwAAAAEAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEBAQAAAAAAAT4AAAAA/////wG5QQLQx5mYHjioERew1MKmAAAAAAAAABEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAL+AAAAAAAAA',
  13: 'AAAMYT8AAAA/QAAAP4AAAD68AaM+////AAAAAAAAAAAAAAAAP4AAAAAAAAAAAAAAAQEBAAAADQAAAAABAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAQgwAAAAAAAAAAAAAviqqrAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABP8ICdQAAAAAAAAAAAAEAAT/CAnUAAAAAAAAAAAACAAFAXtxdAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC/gAAAAAAAAAAAAAAAAAAAP4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMAAAADAAAAAwAAAAAAAAATAAAAAAAAABQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADwj1woAAAAAP4AAAEFwAAAAAAAAAAAAAAAAAAAAAAAAPCPXCgAAAAAAAAAAAAAAAAAAAAA8I9cKP4AAAD+AAAA/gAAAAAAAAAAAAAAAAAAAAAYAAAAAAAAAAAAAAAAAAAAAAAYAAAAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYAAAAGAAAAAAAAAAAAAAAABgAAAAAAAAAAAAAAAAAAAAAABgAAAAYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgAAAAYAAAAAAAAAAAAAAAAGAAAAAAAAAAAAAAAAAAAAAAAGAAAABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAAAABgAAAAAAAAAAAAAAAAYAAAAAAAAAAAAAAAAAAAAAAAYAAAAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYAAAAGAAAAAAAAAAAAAAAABgAAAAAAAAAAAAAAAAAAAAAABgAAAAYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgAAAAYAAAAAAAAAAAAAAAAGAAAAAAAAAAAAAAAAAAAAAAAGAAAABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAAAABgAAAAAAAAAAAAAAP4AAAD+AAAAAAAAAAAAAAAABAQAAAAAAAAAAAAAAAAAAPwAAAAEAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEBAQAAAAAAAT4AAAAA/////wG5QQLQx5mYHjioERew1MKmAAAAAAAAABUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAL+AAAAAAAAA',
  21: 'AAAMYT8AAAA/QAAAP4AAAD68AaM/AAAAAAAAAAAAAAAAAAAAQSAAAAAAAAwAAAANAQEBAAAAFQAAAAABAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAQgwAAAAAAAAAAAAAviqqrAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC/gAAAAAAAAAAAAAAAAAAAP4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAATAAAAAAAAABQAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADwj1woAAAAAP4AAAEFwAAAAAAAAAAAAAAAAAAAAAAAAPCPXCgAAAAAAAAAAAAAAAAAAAAA8I9cKP4AAAD+AAAA/gAAAAAAAAAEAAAAAAQAIAAAAAAABAAAAAEGgAAAAAAAAAAAAAAAGAAAAAAAAAAAAAAAAAAAAAAAAAAAABwAAAAAAAAAGAAAAAQAAAAACAAgAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAYAAAAAAAAAAAAAAAAAAAAAAAAAAAAHAAAAAAAAAAYAAAAAAAAAAAIACAAGAAAAAgAAAAAAAAAAAAAAAAAAAAEABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAcAAAAAAAEABgAAAAAAAAAAAAAAAAYAAAAAAAAAAAAAAAAAAAAAAAYAAAAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYAAAAGAAAAAAAAAAAAAAAABgAAAAAAAAAAAAAAAAAAAAAABgAAAAYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgAAAAYAAAAAAAAAAAAAAAAGAAAAAAAAAAAAAAAAAAAAAAAGAAAABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAAAABgAAAAAAAAAAAAAAP4AAAD+AAAAAAAAADAAAAA0BAQAAAAAAAAAAAAAAAAAAPwAAAAEAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEBAQAAAAAAAT4AAAAA/////wG5QQLQx5mYHjioERew1MKmAAAAAAAAABQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAL+AAAAAAAAA',
  22: 'AAAMYT8AAAA/QAAAP4AAAD68AaM+////AAAAAAAAAAAAAAAAP4AAAAAAAAAAAAAAAQEBAAAAFgAAAAABAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAQgwAAAAAAAAAAAAAviqqrAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC/gAAAAAAAAAAAAAAAAAAAP4AAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAABQAAAAEAAAAAAAAAAgAAAAAAAAATAAAAAAAAABQAAAAAAAAAAAAAAAAAAAAAwKAAAAAAAAAAAAAAAAAAADwj1woAAAAAP4AAAEFwAABA1VVUAAAAAAAAAAAAAAAAPCPXCkEgAAA/gAAAAAAAAAAAAAA8I9cKP4AAAD+AAAA/gAAAAAAAAAAAAAAAAAAAAAYAAAAAAAAAAAAAAAAAAAAAAAYAAAAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYAAAAGAAAAAAAAAAAAAAAABgAAAAAAAAAAAAAAAAAAAAAABgAAAAYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgAAAAYAAAAAAAAAAAAAAAAGAAAAAAAAAAAAAAAAAAAAAAAGAAAABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAAAABgAAAAAAAAAAAAAAAAYAAAAAAAAAAAAAAAAAAAAAAAYAAAAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYAAAAGAAAAAAAAAAAAAAAABgAAAAAAAAAAAAAAAAAAAAAABgAAAAYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgAAAAYAAAAAAAAAAAAAAAAGAAAAAAAAAAAAAAAAAAAAAAAGAAAABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAAAABgAAAAAAAAAAAAAAP4AAAD+AAAAAAAAAAAAAAAABAQAAAAAAAAAAAAAAAAAAPwAAAAEAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEBAQAAAAAAAT4AAAAA/////wG5QQLQx5mYHjioERew1MKmAAAAAAAAAAkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAL+AAAAAAAAA',
  29: 'AAAMYT859lY/HC02PqIGEj68AaM/AAAAAAAAAAAAAAAAAAAAP4AAAAAAAA4AAAAOAQEBAAAAHQAAAAABAAAAAAAAAAAAAAAAAAAAAAABAAABAAAAAAAAAAAAAAAAAAAAAAAAviqqrAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAL+AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP4AAAAAAAAAAAAAOAAAADgAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAATAAAAAAAAABQAAAAAAAAADgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADwj1woAAAAAP4AAAEHwAAAAAAAAAAAAAAAAAAAAAAAAPCPXCgAAAAAAAAAAAAAAAAAAAAA8I9cKP4AAAD+AAAA/gAAAAAAAAAAAAAAAAAAAAAYAAAAAAAAAAAAAAAAAAAAAAAYAAAAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYAAAAGAAAAAAAAAAAAAAAABgAAAAAAAAAAAAAAAAAAAAAABgAAAAYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgAAAAYAAAAAAAAAAAAAAAAGAAAAAAAAAAAAAAAAAAAAAAAGAAAABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAAAABgAAAAAAAAAAAAAAAAYAAAAAAAAAAAAAAAAAAAAAAAYAAAAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYAAAAGAAAAAAAAAAAAAAAABgAAAAAAAAAAAAAAAAAAAAAABgAAAAYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgAAAAYAAAAAAAAAAAAAAAAGAAAAAAAAAAAAAAAAAAAAAAAGAAAABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAAAABgAAAAAAAAAAAAAAP4AAAD+AAAAAAAAAAAAAAAABAQAAAAAAAAAAAAAAAAAAPwAAAAEAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEBAQAAAAAAAD4AAAAA/////wHANWAnPCi4vrgE2bptMNI+AAAAAAAAAA8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAL+AAAAAAAAA'
};

function base64Decode(s) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const lut = new Int16Array(256).fill(-1);
  for (let i = 0; i < chars.length; i++) lut[chars.charCodeAt(i)] = i;
  const clean = s.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor(clean.length * 3 / 4));
  let o = 0, buf = 0, bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = lut[clean.charCodeAt(i)];
    if (v < 0) continue;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buf >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

function base64Encode(u8) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < u8.length; i += 3) {
    const a = u8[i], b = u8[i + 1], c = u8[i + 2];
    out += chars[a >> 2];
    out += chars[((a & 3) << 4) | ((b === undefined ? 0 : b) >> 4)];
    out += b === undefined ? '=' : chars[((b & 15) << 2) | ((c === undefined ? 0 : c) >> 6)];
    out += c === undefined ? '=' : chars[c & 63];
  }
  return out;
}

/** 取某细胞类型的模板段；没有专属模板时退回 phagocyte 的段 */
function templateSegment(cellType, seg) {
  if (seg !== MODERN_SEG) return null;
  const b64 = MODERN_TEMPLATES[cellType] || MODERN_TEMPLATES[0];
  if (!b64) return null;
  return base64Decode(b64);
}

// ============================================================ 外壳

/** 拆掉 Java 序列化外壳，返回裸载荷 */
function unwrap(input) {
  const b = toBytes(input);
  if (b.length < 5) throw new Error('文件太短，不是 .genome');
  if (b[0] !== 0xac || b[1] !== 0xed) {
    throw new Error('不是 Cell Lab 基因组（缺少 Java 流头 AC ED 00 05）');
  }
  const chunks = [];
  let total = 0;
  let p = 4;
  while (p < b.length) {
    const tc = b[p++];
    let n;
    if (tc === 0x77) {
      n = b[p++];
    } else if (tc === 0x7a) {
      if (p + 4 > b.length) throw new Error('块长度字段越界');
      n = ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
      p += 4;
    } else {
      throw new Error(`未知的流标记 0x${tc.toString(16)}（偏移 ${p - 1}）`);
    }
    if (p + n > b.length) throw new Error(`块数据越界（偏移 ${p}，需要 ${n} 字节）`);
    chunks.push(b.subarray(p, p + n));
    total += n;
    p += n;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/** 把裸载荷包回 Java 序列化外壳 */
function wrap(payload) {
  const u8 = toBytes(payload);
  const parts = [];
  let size = 4;
  let o = 0;
  while (o < u8.length) {
    const n = Math.min(BLOCK, u8.length - o);
    // Java 的 TC_BLOCKDATA 长度只有 1 字节；>=256 必须用 TC_BLOCKDATALONG
    parts.push({ n, view: u8.subarray(o, o + n), long: n >= 256 });
    size += (n >= 256 ? 5 : 2) + n;
    o += n;
  }
  const out = new Uint8Array(size);
  out.set(JAVA_MAGIC, 0);
  let w = 4;
  for (const part of parts) {
    if (part.long) {
      out[w++] = 0x7a;
      out[w++] = (part.n >>> 24) & 0xff;
      out[w++] = (part.n >>> 16) & 0xff;
      out[w++] = (part.n >>> 8) & 0xff;
      out[w++] = part.n & 0xff;
    } else {
      out[w++] = 0x77;
      out[w++] = part.n & 0xff;
    }
    out.set(part.view, w);
    w += part.n;
  }
  return out;
}

// ============================================================ 解码

function decodeMode(r, modeSize) {
  const version = r.i32();
  const m = {
    version,
    color: [r.f32(), r.f32(), r.f32()],
    _rawSplitMass: r.f32(),
    splitRatio: r.f32(),
    _rawAngles: [r.f32(), r.f32(), r.f32()],
    priority: r.f32(),
    child1Mode: r.i32() + 1,
    child2Mode: r.i32() + 1,
    makeAdhesin: r.bool(),
    child1KeepAdhesin: r.bool(),
    child2KeepAdhesin: r.bool(),
    cellType: r.i32(),
    reserved: r.i32(),
    stayAlive: r.bool(),
    isInitial: r.bool(),
    mirror1: r.bool(),
    mirror2: r.bool(),
    adhesinStiffness: r.f32(),
  };
  m.splitMass = m._rawSplitMass * 10;
  m.splitAngle = m._rawAngles[0] * DEG;
  m.child1Angle = m._rawAngles[1] * DEG;
  m.child2Angle = m._rawAngles[2] * DEG;

  const t = TYPE_BY_ID.get(m.cellType);
  m.type = t ? t.key : `unknown${m.cellType}`;
  m.typeCn = t ? t.cn : `未知(${m.cellType})`;

  m.values = [];
  for (let i = 0; i < N_VALUES; i++) {
    m.values.push({ input: r.i16(), form: r.i16(), a: r.f32(), b: r.f32(), c: r.f32() });
  }
  m.ints = [];
  for (let i = 0; i < N_INTS; i++) m.ints.push(r.i32());
  m.floats = [];
  for (let i = 0; i < N_FLOATS; i++) m.floats.push(r.f32());
  m._tail = modeSize === MODE_V3055 ? Uint8Array.from(r.raw(16)) : null;
  const mc = m.ints[INT.maxConnections];
  m.maxConnections = (mc >= 0 && mc <= 19) ? mc + 1 : 20;   // 文件里存「界面值 − 1」
  return m;
}

/**
 * 把 .genome 字节解码成可读模型。
 * 两种容器都支持：
 *   - 裸 Java 流（v95 / v3055，段长 315 / 331）
 *   - ZIP 容器（v3145+，内含 save.bin + thumbnail.png + 可选 mode_names.json）
 * @param {Uint8Array|ArrayBuffer|number[]} input
 */
function decodeGenome(input) {
  const bytes = toBytes(input);
  if (isZip(bytes)) {
    const files = zipRead(bytes);
    const save = files.find(f => f.name === 'save.bin');
    if (!save) throw new Error('ZIP 容器里没有 save.bin，不是 Cell Lab 基因组');
    const model = decodeModernSave(save.data);
    model.files = files;
    const mn = files.find(f => f.name === 'mode_names.json');
    if (mn) {
      try { model.modeNames = JSON.parse(utf8Decode(mn.data)); } catch (e) { /* 名字文件坏了不影响主体 */ }
    }
    return model;
  }

  const pl = unwrap(bytes);
  if (pl.length < 4) throw new Error('载荷为空');
  const r0 = new Reader(pl);
  const fileVersion = r0.i32();
  const body = pl.length - 4;

  const order = fileVersion >= 1000 ? [MODE_V3055, MODE_V95] : [MODE_V95, MODE_V3055];
  let modeSize = 0;
  for (const s of order) {
    if (body % s === 0 && body / s >= 1 && body / s <= 512) { modeSize = s; break; }
  }
  if (!modeSize) throw new Error(`无法判定模式段大小（载荷 ${pl.length} 字节，版本 ${fileVersion}）`);

  const count = body / modeSize;
  const r = new Reader(pl);
  r.p = 4;
  const modes = [];
  for (let k = 0; k < count; k++) modes.push(decodeMode(r, modeSize));
  return { container: 'raw', fileVersion, version: fileVersion, modeSize, count, modes };
}

// ============================================================ 编码

/** 值未变时回写原始 float，避免「度↔弧度」「ng↔存储值」两次换算的末位误差 */
function pickRaw(raw, computed) {
  if (raw === undefined || raw === null) return computed;
  return Math.abs(computed - raw) < 1e-9 ? raw : computed;
}

function encodeMode(w, m, modeSize, fallbackTail) {
  w.i32(m.version);
  w.f32(m.color[0]); w.f32(m.color[1]); w.f32(m.color[2]);
  w.f32(pickRaw(m._rawSplitMass, m.splitMass / 10));
  w.f32(m.splitRatio);
  const ra = m._rawAngles || [];
  w.f32(pickRaw(ra[0], m.splitAngle / DEG));
  w.f32(pickRaw(ra[1], m.child1Angle / DEG));
  w.f32(pickRaw(ra[2], m.child2Angle / DEG));
  w.f32(m.priority);
  w.i32(m.child1Mode - 1);
  w.i32(m.child2Mode - 1);
  w.bool(m.makeAdhesin);
  w.bool(m.child1KeepAdhesin);
  w.bool(m.child2KeepAdhesin);
  w.i32(m.cellType);
  w.i32(m.reserved | 0);
  w.bool(m.stayAlive);
  w.bool(m.isInitial);
  w.bool(m.mirror1);
  w.bool(m.mirror2);
  w.f32(m.adhesinStiffness);

  for (let i = 0; i < N_VALUES; i++) {
    const v = m.values[i];
    w.i16(v.input); w.i16(v.form); w.f32(v.a); w.f32(v.b); w.f32(v.c);
  }
  for (let i = 0; i < N_INTS; i++) w.i32(m.ints[i]);
  for (let i = 0; i < N_FLOATS; i++) w.f32(m.floats[i]);
  if (modeSize === MODE_V3055) w.raw(m._tail || fallbackTail);
}

/** 把可读模型编码回 .genome 字节（返回 Uint8Array） */
function encodeGenome(model) {
  const modes = model.modes;
  if (!Array.isArray(modes) || modes.length === 0) throw new Error('模型里没有模式');

  // 新版：ZIP 容器
  if (model.container === 'zip' || modes.some(m => m && m._modern)) {
    const save = encodeModernSave(model);
    const files = [{ name: 'save.bin', data: save }];
    const thumb = model.files && model.files.find(f => f.name === 'thumbnail.png');
    files.push({ name: 'thumbnail.png', data: (thumb && thumb.data) ? thumb.data : PLACEHOLDER_PNG });
    if (model.modeNames && Array.isArray(model.modeNames.names)) {
      files.push({ name: 'mode_names.json', data: utf8Encode(JSON.stringify(model.modeNames)) });
    }
    return zipWriteStored(files);
  }

  // 旧版：裸 Java 流
  const fileVersion = model.fileVersion || model.version || 3055;
  const modeSize = model.modeSize || (fileVersion >= 1000 ? MODE_V3055 : MODE_V95);
  const fallbackTail = model.defaultTail ? toBytes(model.defaultTail) : null;

  const payloadLen = 4 + modes.length * modeSize;
  const w = new Writer(payloadLen);
  w.i32(fileVersion);
  modes.forEach((m, k) => {
    if (!m.version) m.version = fileVersion;
    encodeMode(w, m, modeSize, fallbackTail);
  });
  return wrap(w.buf);
}

// ============================================================ 配方 → 模型

const DEFAULTS = {
  color: [0, 0, 0],
  splitMass: 2.538,
  splitRatio: 0.5,
  splitAngle: 0,
  child1Angle: 0,
  child2Angle: 0,
  priority: 1,
  makeAdhesin: false,
  child1KeepAdhesin: true,
  child2KeepAdhesin: true,
  stayAlive: false,
  isInitial: false,
  mirror1: false,
  mirror2: false,
  adhesinStiffness: 0,
  maxConnections: 20,
  cytoskeleton: 1,
  adhesinLength: 0,
};

/** 官方取值区间（用于校验简易配方；完整模型回灌不做钳位） */
const RANGE = {
  splitMass: [0.648, 3.672],
  splitRatio: [0.1, 0.9],
  priority: [0.01, 100],
  adhesinStiffness: [0, 1],
  adhesinLength: [0, 0.01],
  cytoskeleton: [0.5, 2],
  maxConnections: [1, 20],
};

/** v3055 每段末尾 16 字节扩展，取官方样本原始值 */
const DEFAULT_TAIL = Uint8Array.from([0, 0, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0, 65, 240, 0, 0]);

function defaultValues() {
  const vals = [];
  for (let i = 0; i < N_VALUES; i++) {
    vals.push({ input: 0, form: 0, a: 0, b: i === VAL.swimForce ? -0.16666667 : 0, c: 0 });
  }
  return vals;
}

function emptyMode(index, tail) {
  return {
    version: 3055,
    color: [0, 0, 0],
    splitMass: 3.672,          // = 永不分裂（官方上限）
    splitRatio: 0.5,
    splitAngle: 0,
    child1Angle: 0,
    child2Angle: 0,
    priority: 1,
    child1Mode: index + 1,
    child2Mode: index + 1,
    makeAdhesin: false,
    child1KeepAdhesin: true,
    child2KeepAdhesin: true,
    cellType: 0,
    type: 'phagocyte',
    reserved: 0,
    stayAlive: false,
    isInitial: false,
    mirror1: false,
    mirror2: false,
    adhesinStiffness: 0,
    values: defaultValues(),
    ints: [index, index, 0, 0, 0, 0, 0, 0, 0, 19, 0],
    floats: [0, 0, 0, 0, 0, 0, 1],
    _tail: Uint8Array.from(tail || DEFAULT_TAIL),
  };
}

function num(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function bool(v, def) {
  if (v === undefined || v === null) return def;
  return v === true || v === 1 || v === 'true' || v === 'yes' || v === 'on';
}

const RANGE_CN = {
  splitMass: '分裂质量(ng)', splitRatio: '分裂分配比', priority: '营养优先级',
  adhesinStiffness: '黏附刚度', adhesinLength: '黏附长度',
  cytoskeleton: '细胞硬度', maxConnections: '最大连接数',
};

/** 简易配方：越界直接报错，不静默钳位 */
function ranged(name, v, index) {
  const [lo, hi] = RANGE[name];
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`模式 M${index + 1} 的 ${RANGE_CN[name] || name} 不是数字: ${v}`);
  if (n < lo || n > hi) {
    throw new Error(`模式 M${index + 1} 的 ${RANGE_CN[name] || name} = ${n} 越界，允许 ${lo}..${hi}`);
  }
  return n;
}

/** 把简化配方/完整模型的一段转成模式 */
function applyMode(spec, index, ctx) {
  const m = emptyMode(index, ctx.tail);
  // spec 是否来自 read --json（带 values/ints/floats 的完整模型）
  const isFullModel = Array.isArray(spec.values) && Array.isArray(spec.ints) && Array.isArray(spec.floats);
  // 新版格式（模板式）不做区间校验：真实样本里脂肪细胞能到 12ng 以上
  const lenient = isFullModel || ctx.relaxed === true;

  if (isFullModel) {
    m.values = spec.values.map(v => ({
      input: Math.round(num(v.input, 0)), form: Math.round(num(v.form, 0)),
      a: num(v.a, 0), b: num(v.b, 0), c: num(v.c, 0),
    }));
    m.ints = spec.ints.map(v => Math.round(num(v, 0)));
    m.floats = spec.floats.map(v => num(v, 0));
    if (Array.isArray(spec._tail) && spec._tail.length === 16) m._tail = Uint8Array.from(spec._tail);
  }
  if (Number.isFinite(spec._rawSplitMass)) m._rawSplitMass = spec._rawSplitMass;
  if (Array.isArray(spec._rawAngles) && spec._rawAngles.length === 3) m._rawAngles = spec._rawAngles.slice();
  if (spec.reserved !== undefined) m.reserved = Math.round(num(spec.reserved, 0)) | 0;

  if (spec.type !== undefined) {
    m.cellType = typeId(spec.type);
    const t = TYPE_BY_ID.get(m.cellType);
    m.type = t ? t.key : `type${m.cellType}`;
    m.typeCn = t ? t.cn : `类型 ${m.cellType}（Macro 新增）`;
  } else if (spec.cellType !== undefined) {
    m.cellType = typeId(Number(spec.cellType));
    const t = TYPE_BY_ID.get(m.cellType);
    m.type = t ? t.key : `type${m.cellType}`;
    m.typeCn = t ? t.cn : `类型 ${m.cellType}（Macro 新增）`;
  }

  if (Array.isArray(spec.color)) {
    m.color = [0, 1, 2].map(i => clampFloat(num(spec.color[i], 0), 0, 1));
  } else if (typeof spec.color === 'string') {
    m.color = hexColor(spec.color);
  }

  // 数值字段：完整模型原样保留；简易配方按官方区间校验
  const pass = lenient;
  m.splitMass = pass ? num(spec.splitMass, DEFAULTS.splitMass) : ranged('splitMass', spec.splitMass ?? DEFAULTS.splitMass, index);
  m.splitRatio = pass ? num(spec.splitRatio, DEFAULTS.splitRatio) : ranged('splitRatio', spec.splitRatio ?? DEFAULTS.splitRatio, index);
  m.priority = pass ? num(spec.priority, DEFAULTS.priority) : ranged('priority', spec.priority ?? DEFAULTS.priority, index);
  m.adhesinStiffness = pass ? num(spec.adhesinStiffness, 0) : ranged('adhesinStiffness', spec.adhesinStiffness ?? 0, index);

  m.splitAngle = wrapDeg(num(spec.splitAngle, 0));
  m.child1Angle = wrapDeg(num(spec.child1Angle, 0));
  m.child2Angle = wrapDeg(num(spec.child2Angle, 0));

  m.makeAdhesin = bool(spec.makeAdhesin, DEFAULTS.makeAdhesin);      // 全局默认 false
  m.child1KeepAdhesin = bool(spec.child1KeepAdhesin !== undefined ? spec.child1KeepAdhesin : spec.keepAdhesin, DEFAULTS.child1KeepAdhesin);
  m.child2KeepAdhesin = bool(spec.child2KeepAdhesin, DEFAULTS.child2KeepAdhesin);
  m.stayAlive = bool(spec.stayAlive, DEFAULTS.stayAlive);
  m.mirror1 = bool(spec.mirror1, DEFAULTS.mirror1);
  m.mirror2 = bool(spec.mirror2, DEFAULTS.mirror2);

  // 子模式
  let c1 = spec.child1 !== undefined ? spec.child1 : spec.child1Mode;
  let c2 = spec.child2 !== undefined ? spec.child2 : spec.child2Mode;
  if (Array.isArray(spec.children)) { c1 = spec.children[0]; c2 = spec.children[1]; }
  m.child1Mode = resolveChildMode(c1, index, ctx);
  m.child2Mode = resolveChildMode(c2, index, ctx);

  // 自指默认必须写在 virusFrom/virusTo 之前，否则会被覆盖
  if (isFullModel) {
    // 完整模型：ints 已整体吸收，只在缺失时补自身索引
    if (!Number.isFinite(m.ints[INT.virusFrom])) m.ints[INT.virusFrom] = index;
    if (!Number.isFinite(m.ints[INT.virusTo])) m.ints[INT.virusTo] = index;
  } else {
    m.ints[INT.virusFrom] = index;
    m.ints[INT.virusTo] = index;
  }
  if (spec.virusFrom !== undefined) m.ints[INT.virusFrom] = toModeIndex(spec.virusFrom, index, ctx, 'virusFrom');
  if (spec.virusTo !== undefined) m.ints[INT.virusTo] = toModeIndex(spec.virusTo, index, ctx, 'virusTo');

  // 可编程值：以「实际值」表达，内部转 [-1,1]
  const setVal = (slot, v, min, max) => {
    if (v === undefined || v === null) return;
    m.values[slot].b = -1 + 2 * (clampFloat(Number(v), min, max) - min) / (max - min);
  };
  setVal(VAL.swimForce, spec.swimForce, 0, 1);
  setVal(VAL.density, spec.density, -3, 3);
  setVal(VAL.muscleBend, spec.muscleBend, -1, 1);
  setVal(VAL.muscleContract, spec.muscleContract, -0.5, 0.5);
  setVal(VAL.muscleLift, spec.muscleLift, -1, 1);
  setVal(VAL.stemThreshold1, spec.stemThreshold1, -1, 1);
  setVal(VAL.stemThreshold2, spec.stemThreshold2, -1, 1);

  if (Array.isArray(spec.signals)) {
    for (let i = 0; i < 4; i++) {
      const s = spec.signals[i];
      if (s === undefined || s === null) continue;
      const t = m.values[VAL.signalOut0 + i];
      if (typeof s === 'number') { t.b = clampFloat(s / 20, -1, 1); continue; }
      if (s.value !== undefined) t.b = clampFloat(num(s.value, 0) / 20, -1, 1);
      if (s.input !== undefined) t.input = inputId(s.input);
      if (s.form !== undefined) t.form = s.form === 'threshold' ? 1 : 0;
      if (s.a !== undefined) t.a = num(s.a, 0);
      if (s.offset !== undefined) t.b = num(s.offset, 0);
      if (s.threshold !== undefined) t.c = num(s.threshold, 0);
    }
  }

  if (spec.secreteType !== undefined) m.ints[INT.secreteType] = secreteTypeId(spec.secreteType);
  if (spec.smellSource !== undefined) m.ints[INT.smellSource] = Math.round(clampFloat(num(spec.smellSource, 0), 0, 3));
  if (spec.smellType !== undefined) m.ints[INT.smellType] = Math.round(clampFloat(num(spec.smellType, 0), 0, 6));
  if (spec.maxConnections !== undefined) {
    m.ints[INT.maxConnections] = Math.round(ranged('maxConnections', spec.maxConnections, index)) - 1;
  }
  if (spec.telomerase !== undefined) m.ints[INT.telomerase] = Math.round(clampFloat(num(spec.telomerase, 0), 0, 5));

  if (spec.smellAmount !== undefined) m.floats[FLOAT.smellAmount] = clampFloat(num(spec.smellAmount, 0), -60, 60);
  if (Array.isArray(spec.smellColor)) {
    for (let i = 0; i < 3; i++) m.floats[FLOAT.smellRed + i] = clampFloat(num(spec.smellColor[i], 0), 0, 1);
  }
  if (spec.smellThreshold !== undefined) m.floats[FLOAT.smellThreshold] = clampFloat(num(spec.smellThreshold, 0), 0, 1.732);
  if (spec.adhesinLength !== undefined) {
    m.floats[FLOAT.adhesinLength] = isFullModel ? num(spec.adhesinLength, 0) : ranged('adhesinLength', spec.adhesinLength, index);
  }
  if (spec.cytoskeleton !== undefined) {
    m.floats[FLOAT.cytoskeleton] = isFullModel ? num(spec.cytoskeleton, 1) : ranged('cytoskeleton', spec.cytoskeleton, index);
  }
  return m;
}

function wrapDeg(d) {
  const x = Number.isFinite(d) ? d : 0;
  return ((x % 360) + 360) % 360;
}

/** 子模式号：越界直接报错，不静默钳位 */
function resolveChildMode(v, index, ctx) {
  if (v === undefined || v === null) return index + 1;
  const n = Math.round(num(v, index + 1));
  if (!Number.isFinite(n) || n < 1 || n > ctx.limit) {
    throw new Error(`模式 M${index + 1} 的子模式指向 M${v} 越界：当前配方共 ${ctx.limit} 个模式`);
  }
  return n;
}

function toModeIndex(v, index, ctx, field) {
  const n = Math.round(num(v, index + 1));
  if (n < 1 || n > ctx.limit) {
    throw new Error(`模式 M${index + 1} 的 ${field} 指向 M${v} 越界：当前配方共 ${ctx.limit} 个模式`);
  }
  return n - 1;
}

function hexColor(s) {
  const h = s.replace('#', '');
  if (h.length !== 6) throw new Error(`颜色格式不对: ${s}（应形如 #ff8800）`);
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
}

function inputId(v) {
  if (typeof v === 'number') return Math.round(clampFloat(v, 0, 7));
  const k = String(v).toLowerCase();
  const map = { s1: 0, s2: 1, s3: 2, s4: 3, mass: 4, age: 5, nh3: 6, connections: 7 };
  if (k in map) return map[k];
  throw new Error(`未知输入源: ${v}（可用 s1/s2/s3/s4/mass/age/nh3/connections）`);
}

function secreteTypeId(v) {
  if (typeof v === 'number') return Math.round(clampFloat(v, 0, 6));
  const k = String(v).toLowerCase();
  const t = SECRETE_TYPES.find(x => x.key.toLowerCase() === k || x.cn === v);
  if (!t) throw new Error(`未知分泌类型: ${v}`);
  return t.id;
}

/**
 * 从配方构造完整模型
 * @param {object} spec {name, version, initialMode, modes:[...]}
 * @param {object} [opts] {template} —— decodeGenome 的结果，用于对齐文件结构
 */
function buildModel(spec, opts) {
  const wantModern =
    (opts && opts.format === 'modern') ||
    (spec && (spec.format === 'modern' || spec.container === 'zip')) ||
    (spec && Number(spec.modeSize) > 331) ||
    (spec && Number(spec.fileVersion) >= 1000 && !opts) ||
    (opts && opts.template && opts.template.container === 'zip');
  if (wantModern) return buildModernModel(spec, opts);

  if (!spec || !Array.isArray(spec.modes) || spec.modes.length === 0) {
    throw new Error('配方必须有非空的 modes 数组');
  }
  const tpl = opts && opts.template ? opts.template : null;
  const slotCount = tpl ? tpl.count : N_MODES;
  if (spec.modes.length > slotCount) {
    throw new Error(`最多 ${slotCount} 个模式，收到 ${spec.modes.length}`);
  }
  const version = Number(spec.version) || Number(spec.fileVersion) || (tpl ? tpl.fileVersion : 3055);
  const modeSize = Number(spec.modeSize) || (tpl ? tpl.modeSize : (version >= 1000 ? MODE_V3055 : MODE_V95));
  const tail = tpl && tpl.modes[0] && tpl.modes[0]._tail ? tpl.modes[0]._tail : DEFAULT_TAIL;
  const ctx = { limit: Math.min(slotCount, Math.max(spec.modes.length, 1)), tail };

  const modes = spec.modes.map((s, i) => applyMode(s || {}, i, ctx));
  for (let i = modes.length; i < slotCount; i++) modes.push(emptyMode(i, tail));

  let initAt = 0;
  if (spec.initialMode !== undefined) {
    initAt = Math.round(num(spec.initialMode, 1)) - 1;
    if (initAt < 0 || initAt >= modes.length) throw new Error(`initialMode 越界: ${spec.initialMode}`);
  } else {
    const found = spec.modes.findIndex(s => s && s.isInitial);
    if (found >= 0) initAt = found;
  }
  modes.forEach((m, i) => { m.isInitial = i === initAt; });

  // 原版只有 0..17；Macro 专有编号写进 331 段格式会在游戏里变成别的细胞
  modes.slice(0, spec.modes.length).forEach((m, i) => {
    if (!(m.cellType >= 0 && m.cellType <= 17)) {
      throw new Error('模式 M' + (i + 1) + ' 的细胞类型编号 ' + m.cellType + ' 是 Macro 专有，原版只有 0..17（见 types）');
    }
  });

  if (modeSize === MODE_V95) {
    modes.forEach(m => { m.version = version; m._tail = null; });
    return { fileVersion: version, modeSize: MODE_V95, count: modes.length, modes };
  }
  modes.forEach(m => { m.version = version; if (!m._tail) m._tail = Uint8Array.from(tail); });
  return { fileVersion: version, modeSize: MODE_V3055, count: modes.length, modes };
}

/** 把「界面单位」的值归一化到文件里的 [-1,1] 滑条位置 */
function normSlider(v, min, max) {
  return -1 + 2 * (clampFloat(Number(v), min, max) - min) / (max - min);
}

/**
 * 新版格式的一段：以同类型模板段为底，覆盖标量区 + Value + int + float。
 * 用户没显式写的参数一律沿用模板（真实游戏导出）的值，避免用错误默认值污染。
 */
function applyModernMode(spec, index, ctx) {
  const m = applyMode(spec, index, { limit: ctx.limit, relaxed: true, tail: null });
  m._modern = true;
  m._seg = ctx.seg;
  m.version = ctx.ver;

  // 基底优先级：spec 自带的原始段（read --json 回灌）> 同类型模板段 > 通用模板段
  let segBytes = null;
  if (typeof spec._raw === 'string' && spec._raw.length > 32) {
    const decoded = base64Decode(spec._raw);
    if (decoded.length === ctx.seg) segBytes = decoded;
  } else if (Array.isArray(spec._raw) && spec._raw.length === ctx.seg) {
    segBytes = Uint8Array.from(spec._raw);
  }
  if (!segBytes) segBytes = (ctx.pool && ctx.pool.get(m.cellType)) || ctx.defaultSeg;
  if (!segBytes) throw new Error('缺少模板段，请用 --template 指定一个真实的新版 .genome');
  m._raw = Uint8Array.from(segBytes);

  // 以模板段为基底，读出 17/16/21 三张表
  const base = decodeModernMode(m._raw, 0, ctx.seg);
  m.values = base.values;
  m.ints = base.ints;
  m.floats = base.floats;
  m.flags7 = base.flags7;
  m.ints3 = base.ints3;
  m.flags5 = base.flags5;
  m.floats2 = base.floats2;
  m.maxConnections = base.maxConnections;
  m._rawMaxConn = base._rawMaxConn;

  const has = (k) => spec[k] !== undefined && spec[k] !== null;

  // 可编程值：新旧结构相同（{input,form,a,b,c}），旧格式的 11 项直接铺到前 11 槽
  if (Array.isArray(spec.values)) {
    const n = spec.values.length;
    if (n === M_VALUES_N) {
      m.values = spec.values.map(v => ({
        input: Math.round(num(v.input, 0)), form: Math.round(num(v.form, 0)),
        a: num(v.a, 0), b: num(v.b, 0), c: num(v.c, 0),
      }));
    } else if (n === 11) {
      for (let i = 0; i < 11; i++) {
        const v = spec.values[i];
        m.values[i] = {
          input: Math.round(num(v.input, 0)), form: Math.round(num(v.form, 0)),
          a: num(v.a, 0), b: num(v.b, 0), c: num(v.c, 0),
        };
      }
    } else {
      throw new Error(`values 只接受 ${M_VALUES_N} 项（新版）或 11 项（旧版），收到 ${n}`);
    }
  }
  // ints / floats 两版顺序不同，旧格式回灌时不映射，保留模板值
  if (Array.isArray(spec.ints) && spec.ints.length === M_INTS_N) {
    m.ints = spec.ints.map(v => Math.round(num(v, 0)));
  }
  if (Array.isArray(spec.floats) && spec.floats.length === M_FLOATS_N) {
    m.floats = spec.floats.map(v => num(v, 0));
  }

  // 便捷字段：只覆盖用户写了的
  const setVal = (slot, v, min, max) => { m.values[slot].b = normSlider(v, min, max); };
  if (has('swimForce')) setVal(0, spec.swimForce, 0, 1);
  if (has('density')) setVal(1, spec.density, -3, 3);
  if (has('muscleBend')) setVal(2, spec.muscleBend, -1, 1);
  if (has('muscleContract')) setVal(3, spec.muscleContract, -0.5, 0.5);
  if (has('muscleLift')) setVal(4, spec.muscleLift, -1, 1);
  if (has('stemThreshold1')) setVal(5, spec.stemThreshold1, -1, 1);
  if (has('stemThreshold2')) setVal(6, spec.stemThreshold2, -1, 1);

  if (Array.isArray(spec.signals)) {
    for (let i = 0; i < 4; i++) {
      const v = spec.signals[i];
      if (v === undefined || v === null) continue;
      const t = m.values[7 + i];
      if (typeof v === 'number') { t.b = clampFloat(v / 20, -1, 1); continue; }
      if (v.value !== undefined) t.b = clampFloat(num(v.value, 0) / 20, -1, 1);
      if (v.input !== undefined) t.input = inputId(v.input);
      if (v.form !== undefined) t.form = v.form === 'threshold' ? 1 : 0;
      if (v.a !== undefined) t.a = num(v.a, 0);
      if (v.offset !== undefined) t.b = num(v.offset, 0);
      if (v.threshold !== undefined) t.c = num(v.threshold, 0);
    }
  }

  if (has('maxConnections')) {
    const v = Math.round(clampFloat(Number(spec.maxConnections), 1, 64));
    m.ints[7] = v;
    m.maxConnections = v;
    m._rawMaxConn = v;
  }
  if (has('cytoskeleton')) m.floats[6] = clampFloat(num(spec.cytoskeleton, 1), 0.5, 2);
  if (has('adhesinLength')) m.floats[5] = clampFloat(num(spec.adhesinLength, 0), 0, 0.01);
  if (has('adhesinStiffness')) {
    const v = clampFloat(num(spec.adhesinStiffness, 0), 0, 1);
    m.floats2[0] = v;
    m.adhesinStiffness = v;
  }

  // stayAlive / mirror 映射到 flags7
  if (has('mirror1')) m.flags7[2] = spec.mirror1 ? 1 : 0;
  if (has('mirror2')) m.flags7[3] = spec.mirror2 ? 1 : 0;

  delete m._tail;
  return m;
}

/**
 * 构造新版（ZIP 容器）模型。
 * @param {object} spec
 * @param {object} [opts] {template} —— 真实新版样本，用来对齐版本/段长/尾部/按类型取模板段
 */
function buildModernModel(spec, opts) {
  if (!spec || !Array.isArray(spec.modes) || spec.modes.length === 0) {
    throw new Error('配方必须有非空的 modes 数组');
  }
  const tpl = (opts && opts.template) || null;
  const seg = (tpl && tpl.modeSize) || MODERN_SEG;
  const ver = (tpl && tpl.fileVersion) || 3169;
  const tail = (tpl && tpl.tail && tpl.tail.length) ? Uint8Array.from(tpl.tail) : Uint8Array.from(MODERN_DEFAULT_TAIL);

  const pool = new Map();
  if (tpl && Array.isArray(tpl.modes)) {
    for (const tm of tpl.modes) {
      if (tm._raw && tm._raw.length === seg && !pool.has(tm.cellType)) pool.set(tm.cellType, tm._raw);
    }
  }
  const defaultSeg = templateSegment(0, seg) || (pool.values().next().value) || null;
  const ctx = { limit: spec.modes.length, seg, ver, pool, defaultSeg };
  const modes = spec.modes.map((sm, i) => applyModernMode(sm || {}, i, ctx));

  let initAt = 0;
  if (spec.initialMode !== undefined) {
    initAt = Math.round(num(spec.initialMode, 1)) - 1;
    if (initAt < 0 || initAt >= modes.length) throw new Error(`initialMode 越界: ${spec.initialMode}`);
  } else {
    const f = spec.modes.findIndex(x => x && x.isInitial);
    if (f >= 0) initAt = f;
  }
  modes.forEach((mm, i) => { mm.isInitial = i === initAt; mm.flags7[1] = i === initAt ? 1 : 0; });

  return {
    container: 'zip',
    fileVersion: ver,
    modeSize: seg,
    count: modes.length,
    modes,
    tail,
    files: tpl && tpl.files ? tpl.files : null,
  };
}

function buildGenome(spec, opts) {
  return encodeGenome(buildModel(spec, opts));
}

// ============================================================ 工具

function clampFloat(x, lo, hi) {
  if (!Number.isFinite(x)) return lo;
  return Math.min(hi, Math.max(lo, x));
}

function typeId(name) {
  if (typeof name === 'number') {
    // 原版 0..17；Macro 改版扩到 20+，这里放开到 0..63，未知编号按「类型 N」显示
    if (Number.isInteger(name) && name >= 0 && name < 64) return name;
    throw new Error(`细胞类型编号越界: ${name}（支持 0..63）`);
  }
  const k = String(name).trim().toLowerCase();
  if (TYPE_ALIASES.has(k)) return TYPE_ALIASES.get(k);
  // read --json 会把未知类型写成 type22 这种占位名，原样认回来
  const mm = /^type(\d+)$/.exec(k);
  if (mm && Number(mm[1]) >= 0 && Number(mm[1]) < 64) return Number(mm[1]);
  throw new Error(`未知细胞类型: ${name}（可用: ${CELL_TYPES.map(t => t.key).join(', ')}，或 type<N>）`);
}

function typeName(id) {
  const t = TYPE_BY_ID.get(id);
  return t ? t.cn : `未知(${id})`;
}

/** 初始模式索引；找不到时退回 0 */
function initialIndexOf(model) {
  const i = model.modes.findIndex(m => m.isInitial);
  return i < 0 ? 0 : i;
}

function fmt(n, d) {
  const x = Number(n);
  if (!Number.isFinite(x)) return '0';
  let s = x.toFixed(d === undefined ? 3 : d);
  if (s.indexOf('.') >= 0) s = s.replace(/\.?0+$/, '');   // 只去小数尾零，别把 180 变成 18
  return s || '0';
}

// ============================================================ 生长树

/**
 * 生长逻辑树：从初始模式开始展开，重复出现同一模式即判为递归端点并停止。
 * @param {object} model
 * @param {object} [opts] {maxDepth=6}
 * @returns {string}
 */
function growthTree(model, opts) {
  const o = opts || {};
  const maxDepth = Number.isFinite(Number(o.maxDepth)) ? Number(o.maxDepth) : 6;
  const init = initialIndexOf(model);
  const NEVER = 3.6719;
  const out = [];
  const root = model.modes[init];

  out.push(`生长树 · 从 M${init + 1}（${typeName(root.cellType)}）展开`);
  out.push('规则：母细胞长到分裂门槛即分裂，质量按分配比给两个子细胞；同一模式再次出现即停（防无限递归）');
  out.push('');

  const walk = (modeIdx, mass, prefix, isLast, depth, path) => {
    const m = model.modes[modeIdx];
    const conn = depth === 0 ? '' : (isLast ? '└─ ' : '├─ ');
    const pctTxt = m.__pct === undefined ? '' : `(${fmt(m.__pct * 100, 0)}%) `;
    const label = `${pctTxt}M${modeIdx + 1} ${typeName(m.cellType)}`;
    const hint = modeHint(m);
    const recur = path.indexOf(modeIdx) >= 0;
    const never = m.splitMass >= NEVER;
    const tooDeep = depth >= maxDepth;

    let note = ` · ${fmt(mass, 3)}ng` + (hint ? ` · ${hint}` : '');
    if (recur) note += `  ↻ 递归回到 M${modeIdx + 1}，停止`;
    else if (never) note += '  ■ 永不分裂';
    else if (tooDeep) note += `  … 到达 ${maxDepth} 层上限，停止`;

    if (depth === 0) {
      out.push(`${label}${note}`);
      out.push(`   分裂门槛 ${fmt(m.splitMass, 3)}ng · ${m.makeAdhesin ? '分裂后粘连' : '分裂后不粘连'} · 角 ${fmt(m.splitAngle, 0)}° 子角 ${fmt(m.child1Angle, 0)}°/${fmt(m.child2Angle, 0)}°`);
    } else {
      out.push(`${prefix}${conn}${label}${note}`);
    }

    if (recur || never || tooDeep) return;

    const nextPath = path.concat([modeIdx]);
    const childPrefix = depth === 0 ? '' : prefix + (isLast ? '   ' : '│  ');
    const m1 = m.splitMass * m.splitRatio;
    const m2 = m.splitMass * (1 - m.splitRatio);
    // 先子2（反侧）后子1，与游戏里「左/右」直觉一致
    const kids = [
      { idx: m.child2Mode - 1, mass: m2, pct: 1 - m.splitRatio, last: false },
      { idx: m.child1Mode - 1, mass: m1, pct: m.splitRatio, last: true },
    ];
    for (const k of kids) {
      const km = model.modes[k.idx];
      if (!km) continue;
      km.__pct = k.pct;
      walk(k.idx, k.mass, childPrefix, k.last, depth + 1, nextPath);
      delete km.__pct;
    }
  };

  walk(init, root.splitMass, '', true, 0, []);

  const reach = reachableModes(model);
  out.push('');
  out.push(`可达模式 ${reach.size} 个：${[...reach].sort((a, b) => a - b).map(i => `M${i + 1}`).join(' ')}`);
  return out.join('\n');
}

/** 从初始模式可达的模式集合 */
function reachableModes(model) {
  const start = initialIndexOf(model);
  const seen = new Set([start]);
  const q = [start];
  while (q.length) {
    const i = q.shift();
    const m = model.modes[i];
    if (!m) continue;
    const n = model.modes.length;
    for (const c of [m.child1Mode - 1, m.child2Mode - 1]) {
      if (c >= 0 && c < n && !seen.has(c)) { seen.add(c); q.push(c); }
    }
  }
  return seen;
}

// ============================================================ 模拟器

/** 质量 → 半径(μm)：面积 ∝ 质量，3.6ng 对应直径 30μm */
function radiusOf(mass) {
  return 7.905694150420948 * Math.sqrt(Math.max(mass, 1e-6));
}

function angDiff(a, b) {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * 结构模拟：无限光照 + 无限食物，只看分裂几何与黏附拓扑。
 *
 * 这是「几何/拓扑近似」，不是物理引擎：
 *   - 细胞按质量增长，达门槛且年龄够就分裂
 *   - 子细胞相切放置，黏附连接按距离约束松弛
 *   - 鞭毛细胞出生时若鞭毛方向被姐妹细胞挡住 → 判死（游戏内的即死规则）
 *
 * @param {object} model
 * @param {object} [opts] {maxCells=150, maxSteps, growthRate, verbose}
 */
function simulate(model, opts) {
  const o = opts || {};
  const maxCells = Math.round(clampFloat(o.maxCells === undefined ? 150 : o.maxCells, 1, 300));
  const maxSteps = Math.round(clampFloat(o.maxSteps === undefined ? 4000 : o.maxSteps, 10, 200000));
  const GROWTH = Number.isFinite(o.growthRate) ? o.growthRate : 0.9;   // ng/h
  const DT = 0.05;                                                     // h
  const MIN_AGE = 0.5;                                                 // h，游戏内最小分裂年龄
  const NEVER = 3.6719;

  const cells = [];
  let nextId = 0;
  const events = [];   // 事件日志
  const warn = [];

  const make = (modeIdx, mass, x, y, angle, parent) => {
    const m = model.modes[modeIdx];
    const c = {
      id: nextId++, mode: modeIdx, cellType: m.cellType, mass,
      x, y, angle, r: radiusOf(mass), age: 0, links: [], parent, alive: true,
    };
    cells.push(c);
    return c;
  };

  const link = (a, b) => {
    if (!a || !b || a === b || !a.alive || !b.alive) return;
    if (a.links.indexOf(b.id) >= 0) return;
    a.links.push(b.id);
    b.links.push(a.id);
  };

  const byId = (id) => cells.find(c => c.id === id);
  const alive = () => cells.filter(c => c.alive);

  const initIdx = initialIndexOf(model);
  const initMode = model.modes[initIdx];
  const startMass = Math.max(0.648, Math.min(initMode.splitMass * 0.5, 2.0));
  make(initIdx, startMass, 0, 0, 0, null);
  events.push(`t=0.00h 放置 M${initIdx + 1} ${typeName(initMode.cellType)}（${fmt(startMass, 3)}ng）`);

  /** 绕 b 把 p 旋转 dAng（用于抗弯） */
  const rotAround = (p, b, dAng) => {
    const dx = p.x - b.x, dy = p.y - b.y;
    const ca = Math.cos(dAng), sa = Math.sin(dAng);
    p.x = b.x + dx * ca - dy * sa;
    p.y = b.y + dx * sa + dy * ca;
  };

  /**
   * 局部松弛：
   *   1) 黏附连接保持「相切距离」
   *   2) 黏附抗弯（游戏里 adhesin stiffness 抑制弯折，否则链会卷成一团）
   *   3) 非黏附细胞不穿模
   */
  const relax = (seeds, iters) => {
    const ids = new Set();
    const collect = (id, depth) => {
      if (depth < 0 || ids.has(id)) return;
      const c = byId(id);
      if (!c || !c.alive) return;
      ids.add(id);
      if (depth === 0) return;
      for (const l of c.links) collect(l, depth - 1);
    };
    for (const s of seeds) if (s && s.alive) collect(s.id, 2);   // 两跳邻域
    const set = [...ids].map(byId).filter(c => c && c.alive);
    if (set.length < 2) return;
    const n = iters === undefined ? 6 : iters;
    const MIN_ANGLE = 2.2;      // 相邻两段黏附至少张开约 126°

    for (let it = 0; it < n; it++) {
      // 1) 连接距离约束
      for (const c of set) {
        for (const lid of c.links) {
          const d = byId(lid);
          if (!d || !d.alive || d.id < c.id) continue;
          const dx = d.x - c.x, dy = d.y - c.y;
          const dist = Math.hypot(dx, dy) || 1e-6;
          const target = c.r + d.r;
          const push = (dist - target) / dist * 0.5;
          c.x += dx * push; c.y += dy * push;
          d.x -= dx * push; d.y -= dy * push;
        }
      }
      // 2) 抗弯：a-b-c 夹角过小就掰开
      for (const b of set) {
        const nb = [];
        for (const lid of b.links) {
          const x = byId(lid);
          if (x && x.alive && ids.has(x.id)) nb.push(x);
        }
        for (let i = 0; i < nb.length; i++) {
          for (let j = i + 1; j < nb.length; j++) {
            const a = nb[i], c2 = nb[j];
            const v1x = a.x - b.x, v1y = a.y - b.y;
            const v2x = c2.x - b.x, v2y = c2.y - b.y;
            const l1 = Math.hypot(v1x, v1y) || 1e-6;
            const l2 = Math.hypot(v2x, v2y) || 1e-6;
            const cosv = (v1x * v2x + v1y * v2y) / (l1 * l2);
            const ang = Math.acos(Math.max(-1, Math.min(1, cosv)));
            if (ang < MIN_ANGLE) {
              const d = (MIN_ANGLE - ang) * 0.09;
              rotAround(a, b, d);
              rotAround(c2, b, -d);
            }
          }
        }
      }
      // 3) 非连接穿模
      for (let i = 0; i < set.length; i++) {
        for (let j = i + 1; j < set.length; j++) {
          const a = set[i], b = set[j];
          if (a.links.indexOf(b.id) >= 0) continue;
          const dx = b.x - a.x, dy = b.y - a.y;
          const dist = Math.hypot(dx, dy) || 1e-6;
          const target = a.r + b.r;
          if (dist >= target) continue;
          const push = (dist - target) / dist * 0.5;
          a.x += dx * push; a.y += dy * push;
          b.x -= dx * push; b.y -= dy * push;
        }
      }
    }
  };

  /** 鞭毛细胞出生时鞭毛被姐妹细胞挡住 → 即死 */
  const flagellumBlocked = (child, sister, hasGlue) => {
    if (!hasGlue || !sister || !sister.alive) return false;
    if (child.cellType !== 1) return false;
    const back = child.angle + Math.PI;          // 鞭毛在细胞后方
    const ang = Math.atan2(sister.y - child.y, sister.x - child.x);
    if (Math.abs(angDiff(ang, back)) > Math.PI / 3) return false;
    return Math.hypot(sister.x - child.x, sister.y - child.y) < (child.r + sister.r) * 1.25;
  };

  /** 执行一次分裂 */
  const splitCell = (c, t) => {
    const m = model.modes[c.mode];
    if (!c.alive) return;
    const ratio = clampFloat(m.splitRatio, 0.1, 0.9);
    const m1 = c.mass * ratio;
    const m2 = c.mass * (1 - ratio);
    const r1 = radiusOf(m1), r2 = radiusOf(m2);

    const axis = c.angle + m.splitAngle / DEG;
    const ux = Math.cos(axis), uy = Math.sin(axis);
    // 子细胞朝向都相对分裂轴，不加 180°（位置才分两侧）
    const ang1 = axis + m.child1Angle / DEG;
    const ang2 = axis + m.child2Angle / DEG;

    // 位置：沿分裂轴两侧放置，保证两球相切
    const ax1 = c.x + ux * r1, ay1 = c.y + uy * r1;
    const ax2 = c.x - ux * r2, ay2 = c.y - uy * r2;

    c.alive = false;
    c.consumed = true;                  // 被分裂消耗，不算死亡

    const child1 = make(m.child1Mode - 1, m1, ax1, ay1, ang1, c.id);
    const child2 = make(m.child2Mode - 1, m2, ax2, ay2, ang2, c.id);

    // 黏附：本次分裂产生的姐妹连接
    if (m.makeAdhesin) link(child1, child2);

    // 继承父代已有连接：按方向分给离得更近的子细胞
    const inherited1 = [], inherited2 = [];
    for (const lid of c.links) {
      const p = byId(lid);
      if (!p || !p.alive) continue;
      const ang = Math.atan2(p.y - c.y, p.x - c.x);
      const to1 = Math.abs(angDiff(ang, ang1)) <= Math.PI / 2;
      const keeper = to1 ? child1 : child2;
      const keep = to1 ? m.child1KeepAdhesin : m.child2KeepAdhesin;
      if (keep) (to1 ? inherited1 : inherited2).push(p);
    }
    // 断开父连接
    for (const lid of c.links) {
      const p = byId(lid);
      if (p) p.links = p.links.filter(x => x !== c.id);
    }
    c.links = [];
    for (const p of inherited1) link(child1, p);
    for (const p of inherited2) link(child2, p);

    relax([child1, child2], 12);

    // 鞭毛即死判定
    let died = false;
    if (flagellumBlocked(child1, child2, m.makeAdhesin)) {
      child1.alive = false; died = true;
      warn.push(`t=${fmt(t, 2)}h M${child1.mode + 1} 鞭毛细胞出生即死：鞭毛方向被姐妹细胞 M${child2.mode + 1} 挡住`);
    }
    if (flagellumBlocked(child2, child1, m.makeAdhesin)) {
      child2.alive = false; died = true;
      warn.push(`t=${fmt(t, 2)}h M${child2.mode + 1} 鞭毛细胞出生即死：鞭毛方向被姐妹细胞 M${child1.mode + 1} 挡住`);
    }

    events.push(`t=${fmt(t, 2)}h M${c.mode + 1}→M${child1.mode + 1}+M${child2.mode + 1}（${fmt(m1, 2)}/${fmt(m2, 2)}ng，${m.makeAdhesin ? '粘' : '散'}${died ? '，有子细胞死亡' : ''}）`);
    return true;
  };

  // ---- 主循环 ----
  let t = 0;
  let steps = 0;
  let capped = false;
  const splitCount = new Map();     // mode -> 分裂次数（检测无进展递归）
  while (steps < maxSteps) {
    steps++;
    const liv = alive();
    if (liv.length >= maxCells) { capped = true; break; }

    // 生长（质量上限：普通细胞 3.6ng，脂肪细胞 4.5ng）
    for (const c of liv) {
      const cap = c.cellType === 4 ? 21.6 : 3.6;   // 脂肪细胞 = 3.6ng 本体 + 18ng 脂肪
      c.mass = Math.min(cap, c.mass + GROWTH * DT);
      c.age += DT;
      c.r = radiusOf(c.mass);
    }
    t += DT;

    // 挑一个能分裂的（质量最富裕者优先）
    let pick = null;
    for (const c of liv) {
      const m = model.modes[c.mode];
      if (c.cellType === 16) continue;             // 配子不分裂，只能融合
      if (m.splitMass >= NEVER) continue;
      if (c.age < MIN_AGE) continue;
      if (c.mass < m.splitMass) continue;
      const maxConn = (m.ints && Number.isFinite(m.ints[INT.maxConnections])) ? m.ints[INT.maxConnections] + 1 : 20;
      if (c.links.length >= maxConn) continue;   // 连接数上限
      if (!pick || c.mass - m.splitMass > pick.c.mass - model.modes[pick.c.mode].splitMass) {
        pick = { c, m };
      }
    }
    if (!pick) {
      // 没有可分裂的：若还有能长大的细胞就继续，否则结束
      const canGrow = liv.some(c => model.modes[c.mode].splitMass < NEVER && c.age >= 0 && c.mass < model.modes[c.mode].splitMass);
      if (!canGrow) break;
      if (t > 400) break;
      continue;
    }
    splitCell(pick.c, t);
    if (t > 400) break;
  }

  // ---- 结算 ----
  const liv = alive();
  // 最终整理一次全局几何
  relax(liv, 25);

  // 连通分量
  const idMap = new Map(liv.map(c => [c.id, c]));
  const seen = new Set();
  const groups = [];
  for (const c of liv) {
    if (seen.has(c.id)) continue;
    const stack = [c];
    const members = [];
    seen.add(c.id);
    while (stack.length) {
      const cur = stack.pop();
      members.push(cur);
      for (const lid of cur.links) {
        if (seen.has(lid)) continue;
        const nx = idMap.get(lid);
        if (!nx) continue;
        seen.add(lid);
        stack.push(nx);
      }
    }
    const hasGlue = members.some(mm => mm.links.length > 0);
    groups.push({ members, glued: hasGlue });
  }
  groups.sort((a, b) => b.members.length - a.members.length);

  // 重叠检测（错位告警）
  let overlaps = 0;
  for (let i = 0; i < liv.length; i++) {
    for (let j = i + 1; j < liv.length; j++) {
      const a = liv[i], b = liv[j];
      if (a.links.indexOf(b.id) >= 0) continue;
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      if (d < (a.r + b.r) * 0.55) overlaps++;
    }
  }
  if (overlaps > 0) {
    warn.push(`检测到 ${overlaps} 处非黏附细胞显著重叠，可能由分裂角度或子角设置导致错位`);
  }

  const summary = {
    cells: liv.length,
    totalCreated: cells.length,
    splits: cells.filter(c => c.consumed).length,
    dead: cells.filter(c => !c.alive && !c.consumed).length,
    groups: groups.map((g, i) => {
      const byMode = new Map();
      for (const mm of g.members) byMode.set(mm.mode, (byMode.get(mm.mode) || 0) + 1);
      const comp = [...byMode.entries()].sort((a, b) => b[1] - a[1]).map(([mode, n]) => ({
        mode: mode + 1, type: typeName(model.modes[mode].cellType), count: n, pct: n / g.members.length,
      }));
      const totalMass = g.members.reduce((s, mm) => s + mm.mass, 0);
      const cx = g.members.reduce((s, mm) => s + mm.x, 0) / g.members.length;
      const cy = g.members.reduce((s, mm) => s + mm.y, 0) / g.members.length;
      const spread = Math.max(...g.members.map(mm => Math.hypot(mm.x - cx, mm.y - cy) + mm.r));
      return {
        index: i + 1, size: g.members.length, glued: g.glued,
        composition: comp, totalMass, center: [cx, cy], radius: spread,
        showPct: g.glued && g.members.length > 1,
      };
    }),
    time: t, capped, steps, warnings: warn, events,
  };
  return summary;
}

/** 百分比最大余数分配，保证合计恰好 100% */
function pctAlloc(counts, total) {
  if (!total) return counts.map(() => 0);
  const raw = counts.map(n => n / total * 100);
  const out = raw.map(v => Math.floor(v));
  let rest = 100 - out.reduce((a, b) => a + b, 0);
  const order = raw.map((v, i) => ({ i, frac: v - Math.floor(v) })).sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < rest; k++) out[order[k % order.length].i]++;
  return out;
}

/** 模拟结果 → 中文文本报告 */
function formatSimulation(sim, model, opts) {
  const o = opts || {};
  const L = [];
  L.push(`结构模拟 · ${sim.cells} 个细胞 / ${sim.groups.length} 个整体 · 模拟时长 ${fmt(sim.time, 1)}h`);
  L.push(`（无限光照 + 无限食物；只看分裂几何与黏附拓扑）`);
  if (sim.capped) L.push(`⚠ 已达细胞上限 ${o.maxCells === undefined ? 150 : o.maxCells}，提前终止`);
  L.push('');

  if (!sim.groups.length) {
    L.push('没有任何活细胞。');
    return L.join('\n');
  }

  L.push('整体清单（按大小排序）：');
  for (const g of sim.groups) {
    const kind = g.glued ? '黏连整体' : (g.size === 1 ? '独立单细胞' : '未黏连的散细胞群');
    L.push(`  整体 ${g.index}｜${g.size} 个细胞｜${kind}｜总质量 ${fmt(g.totalMass, 2)}ng｜半径约 ${fmt(g.radius, 1)}μm`);
    if (g.showPct) {
      const pcts = pctAlloc(g.composition.map(c => c.count), g.size);
      const parts = g.composition.map((c, i) => `M${c.mode} ${c.type} ${c.count} 个(${pcts[i]}%)`);
      L.push(`     组成：${parts.join('，')}`);
    } else if (g.size > 1) {
      const parts = g.composition.map(c => `M${c.mode} ${c.type} ×${c.count}`);
      L.push(`     组成：${parts.join('，')}（未黏连，不计比例）`);
    } else {
      L.push(`     组成：M${g.composition[0].mode} ${g.composition[0].type}（单细胞，无比例）`);
    }
  }

  // 汇总各模式分布
  const all = new Map();
  for (const g of sim.groups) {
    for (const c of g.composition) {
      const cur = all.get(c.mode) || { mode: c.mode, type: c.type, n: 0 };
      cur.n += c.count;
      all.set(c.mode, cur);
    }
  }
  const tot = sim.cells || 1;
  L.push('');
  L.push('全池分布：' + [...all.values()].sort((a, b) => b.n - a.n)
    .map(x => `M${x.mode} ${x.type} ${x.n}(${fmt(x.n / tot * 100, 0)}%)`).join('  '));

  if (sim.dead > 0) L.push(`\n死亡 ${sim.dead} 个细胞（含鞭毛出生即死）`);
  if (sim.warnings.length) {
    L.push('\n注意：');
    for (const w of sim.warnings) L.push('  - ' + w);
  }
  if (o.showEvents && sim.events.length) {
    L.push('\n分裂事件（前 40 条）：');
    for (const e of sim.events.slice(0, 40)) L.push('  ' + e);
    if (sim.events.length > 40) L.push(`  …共 ${sim.events.length} 条`);
  }
  return L.join('\n');
}

// ============================================================ 导出

const API = {
  // 常量
  JAVA_MAGIC, BLOCK, MODE_V95, MODE_V3055, N_VALUES, N_INTS, N_FLOATS, N_MODES,
  CELL_TYPES, TYPE_BY_KEY, TYPE_BY_ID, CELL_MECHANICS, mechanicsOf, VAL, INT, FLOAT, INPUTS, SECRETE_TYPES,
  DEFAULTS, RANGE, DEFAULT_TAIL, MODERN_DEFAULT_TAIL, MODERN_SEG, MODERN_TEMPLATES, DEG,
  // 字节层
  toBytes, unwrap, wrap, isZip, zipRead, zipWriteStored, inflateRaw, crc32, base64Encode, base64Decode,
  // 模型层
  decodeGenome, encodeGenome, buildModel, buildGenome, decodeModernSave, encodeModernSave,
  // 查询
  typeId, typeName, initialIndexOf, reachableModes,
  // 分析
  growthTree, simulate, formatSimulation,
  // 版本
  VERSION: '2.1.0',
};

if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof globalThis !== 'undefined') globalThis.CellLab = API;
