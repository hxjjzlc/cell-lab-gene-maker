#!/usr/bin/env node
'use strict';
/**
 * 薄壳 CLI —— 只做参数解析 + 文件读写，全部逻辑在 celllab.js 里。
 *
 * 非 Node 宿主（浏览器 / QuickJS / 小程序）不要用本文件，
 * 直接 require/引入 celllab.js，调 buildGenome / decodeGenome / growthTree / simulate。
 */
const L = require('./celllab.js');

function readJson(p) {
  const fs = require('fs');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function readBytes(p) {
  const fs = require('fs');
  return L.toBytes(fs.readFileSync(p));
}
function writeBytes(p, u8) {
  const fs = require('fs');
  const path = require('path');
  const dir = path.dirname(path.resolve(p));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, u8);
}

const USAGE = `Cell Lab 基因制作器 v1.1.0

用法:
  node cli.js make <配方.json> -o <输出.genome> [--template <参考.genome>] [--template 参考.genome]
  node cli.js read <文件.genome> [--json]        解析（默认中文报告）
  node cli.js verify <文件.genome>               结构体检
  node cli.js tree <配方.json|文件.genome> [--depth N] [--mass]
  node cli.js sim  <配方.json|文件.genome> [--max-cells N] [--events]
  node cli.js types                              18 种细胞类型
  node cli.js presets                            列出内置配方

生成后在游戏里：实验楼 → 基因编辑器 → Load → 从文件载入`;

function main(argv) {
  const cmd = argv[0];
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { console.log(USAGE); return 0; }
  if (cmd === 'types') return cmdTypes(argv.slice(1));
  if (cmd === 'presets') return cmdPresets();
  if (cmd === 'make') return cmdMake(argv.slice(1));
  if (cmd === 'read') return cmdRead(argv.slice(1));
  if (cmd === 'verify') return cmdVerify(argv.slice(1));
  if (cmd === 'tree') return cmdTree(argv.slice(1));
  if (cmd === 'sim') return cmdSim(argv.slice(1));
  console.error(`未知命令: ${cmd}\n`);
  console.log(USAGE);
  return 1;
}

function flag(args, name, def) {
  const i = args.indexOf(name);
  if (i < 0) return def;
  const v = args[i + 1];
  return v === undefined ? true : v;
}
function positional(args, named) {
  const skip = new Set();
  for (const n of named) {
    const i = args.indexOf(n);
    if (i >= 0) { skip.add(i); if (args[i + 1] !== undefined && !String(args[i + 1]).startsWith('--')) skip.add(i + 1); }
  }
  return args.filter((a, i) => !skip.has(i) && !String(a).startsWith('--'));
}

/** 输入既可以是配方 json，也可以是 .genome，统一拿到 model */
function loadModel(file, tplFile) {
  const isGenome = /\.genome$/i.test(file);
  if (isGenome) return L.decodeGenome(readBytes(file));
  const spec = readJson(file);
  const opts = tplFile ? { template: L.decodeGenome(readBytes(tplFile)) } : undefined;
  return L.buildModel(spec, opts);
}

function cmdTypes(args) {
  if (args && args.indexOf('--json') >= 0) {
    const rows = L.CELL_TYPES.map(t => Object.assign({ id: t.id, key: t.key, en: t.en, cn: t.cn }, L.CELL_MECHANICS[t.key] || {}));
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }
  console.log('Cell Lab 原版 18 种细胞（编号即文件里的 cellType）\n');
  const use = {
    phagocyte: '吃营养颗粒，产能量', flagellocyte: '鞭毛推进，会游',
    photocyte: '光合作用产能量', devorocyte: '贴住别的细胞吸取营养',
    lipocyte: '储存脂肪、能量库', keratinocyte: '抗攻击的硬壳',
    buoyocyte: '浮力气泡，可调密度', glueocyte: '碰到就粘住',
    virocyte: '把基因注入别的细胞', nitrocyte: '固氮，低氮环境必备',
    stereocyte: '左右气味差，用来转向', senseocyte: '闻气味浓度',
    myocyte: '肌肉，收缩/弯曲/抬举', neurocyte: '神经，输出信号物质',
    secrocyte: '分泌物质（营养/毒素）', stemocyte: '按信号分化成其他模式',
    gamete: '配子，可融合', ciliocyte: '纤毛，抓地移动',
  };
  console.log('编号  英文名          中文名        典型用途');
  for (const t of L.CELL_TYPES) {
    console.log(` ${String(t.id).padStart(2)}   ${t.en.padEnd(15)} ${t.cn.padEnd(10)} ${use[t.key] || ''}`);
  }
  console.log('\n专属参数与机制（值槽 = Value[]，整型槽 = int[]，浮点槽 = float[]）：');
  for (const t of L.CELL_TYPES) {
    const mech = L.CELL_MECHANICS[t.key] || {};
    const parts = [];
    for (const v of (mech.v || [])) parts.push('值' + v[0] + ' ' + v[1] + '（界面 = 系数×' + v[2] + '+' + v[3] + '）');
    for (const x of (mech.i || [])) parts.push('整型' + x[0] + ' ' + x[1]);
    for (const f of (mech.f || [])) parts.push('浮点' + f[0] + ' ' + f[1]);
    if (parts.length) console.log('  ' + t.key.padEnd(13) + parts.join('；'));
  }
  console.log('\n机制要点：');
  for (const t of L.CELL_TYPES) {
    const mech = L.CELL_MECHANICS[t.key] || {};
    if (mech.notes && mech.notes.length) console.log('  ' + t.cn + '：' + mech.notes.join('；'));
  }
  return 0;
}

function cmdPresets() {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, 'presets');
  if (!fs.existsSync(dir)) { console.log('没有 presets 目录'); return 0; }
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json'))) {
    let name = '';
    try { name = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).name || ''; } catch (e) { /* 忽略 */ }
    console.log(`  ${f.padEnd(18)} ${name}`);
  }
  return 0;
}

function cmdMake(args) {
  const files = positional(args, ['-o', '--template', '--format']);
  const input = files[0];
  if (!input) { console.error('缺少配方文件。示例: node cli.js make presets/swimmer.json -o out.genome'); return 1; }
  const outArg = flag(args, '-o', null);
  const tplArg = flag(args, '--template', null);
  const fmtArg = flag(args, '--format', null);
  if (!outArg || outArg === true) { console.error('缺少 -o <输出.genome>（嵌入宿主请显式给输出路径）'); return 1; }

  let spec;
  try { spec = readJson(input); } catch (e) { console.error(`读取配方失败: ${e.message}`); return 1; }

  let model;
  try {
    const opts = {};
    if (tplArg && tplArg !== true) {
      opts.template = L.decodeGenome(readBytes(tplArg));
      console.log(`模板: ${tplArg} → v${opts.template.fileVersion} · ${opts.template.count} 槽 · 每段 ${opts.template.modeSize} 字节`);
    }
    if (fmtArg && fmtArg !== true) opts.format = fmtArg;
    model = L.buildModel(spec, opts);
  } catch (e) {
    console.error(`生成失败: ${e.message}`);
    return 1;
  }

  const bytes = L.encodeGenome(model);
  writeBytes(outArg, bytes);

  const back = L.decodeGenome(bytes);
  const used = spec.modes.length;
  const init = L.initialIndexOf(back);
  console.log(`已生成: ${outArg}`);
  const kind = back.container === 'zip' ? 'ZIP 容器' : '裸 Java 流';
  console.log(`  大小 ${bytes.length} 字节 · ${back.count} 个模式槽 · ${kind} · v${back.fileVersion}（每段 ${back.modeSize} 字节）`);
  console.log(`  使用模式 M1..M${used}，初始模式 M${init + 1}`);
  console.log('  回读校验: 通过');
  console.log('\n传入手机后在游戏里: 实验楼 → 基因编辑器 → Load → 从文件载入');
  return 0;
}

function strip(m) {
  const o = {};
  for (const k of Object.keys(m)) {
    if (k === '_tail') { if (m._tail) o._tail = Array.from(m._tail); continue; }
    if (k === '_rawAngles') { o._rawAngles = m._rawAngles.slice(); continue; }
    if (k === '_raw') { if (m._raw) o._raw = L.base64Encode(m._raw); continue; }
    // 派生字段：由 ints/floats 算出，回灌时会重复写入，不输出
    if (k === 'typeCn' || k === 'maxConnections' || k === '_rawMaxConn') continue;
    o[k] = m[k];
  }
  return o;
}

function cmdRead(args) {
  const input = positional(args, [])[0];
  if (!input) { console.error('缺少 .genome 文件'); return 1; }
  let model;
  try { model = L.decodeGenome(readBytes(input)); } catch (e) { console.error(`解析失败: ${e.message}`); return 1; }

  if (args.indexOf('--json') >= 0) {
    console.log(JSON.stringify({
      container: model.container,
      format: model.container === 'zip' ? 'modern' : 'raw',
      fileVersion: model.fileVersion,
      modeSize: model.modeSize,
      modes: model.modes.map(strip),
    }, null, 2));
    return 0;
  }

  const path = require('path');
  console.log(`${path.basename(input)} · 格式 v${model.fileVersion} · ${model.count} 个模式槽 · 每段 ${model.modeSize} 字节\n`);
  const init = L.initialIndexOf(model);
  const reach = L.reachableModes(model);
  const list = [...reach].sort((a, b) => a - b);

  for (const i of list) {
    const m = model.modes[i];
    const tag = i === init ? ' ★初始' : '';
    console.log(`M${i + 1}  ${m.typeCn} (${m.type})${tag}`);
    console.log(`   颜色 rgb(${m.color.map(c => Math.round(c * 255)).join(',')})  分裂质量 ${m.splitMass.toFixed(3)}ng  分配 ${m.splitRatio.toFixed(2)}  优先级 ${m.priority.toFixed(2)}`);
    console.log(`   分裂角 ${m.splitAngle.toFixed(0)}°  子角 ${m.child1Angle.toFixed(0)}°/${m.child2Angle.toFixed(0)}°  子模式 M${m.child1Mode}/M${m.child2Mode}  黏附 ${m.makeAdhesin ? '是' : '否'}`);
    const extra = [];
    if (m.values && m.ints) {
      if (m.cellType === 1) extra.push(`游泳力 ${((m.values[L.VAL.swimForce].b + 1) / 2).toFixed(2)}`);
      if (m.cellType === 6) extra.push(`密度 ${(m.values[L.VAL.density].b * 3).toFixed(2)}`);
      if (m.cellType === 14) extra.push(`分泌 ${(L.SECRETE_TYPES[m.ints[L.INT.secreteType]] || {}).cn || m.ints[L.INT.secreteType]}`);
      if (m.cellType === 13) extra.push(`信号 ${m.values.slice(7, 11).map(v => (v.b * 20).toFixed(1)).join('/')}`);
    } else if (m._modern) {
      // 新版：17 个可编程值 / 16 个整型 / 21 个浮点
      const used = m.values
        .map((v, i) => ({ i, v }))
        .filter(x => Math.abs(x.v.b) > 1e-9 || x.v.input || x.v.form);
      if (used.length) {
        extra.push('可编程值 ' + used.slice(0, 6).map(x =>
          `[${x.i}]in${x.v.input}${x.v.form ? '阈' : ''}b=${x.v.b.toFixed(2)}`).join(' '));
      }
      if (m.cellType === 1) extra.push(`游泳力 ${((m.values[0].b + 1) / 2).toFixed(2)}`);
      const nzI = m.ints.map((v, i) => v ? `${i}:${v}` : null).filter(Boolean).slice(0, 8);
      if (nzI.length) extra.push('ints ' + nzI.join(' '));
      const nzF = m.floats.map((v, i) => Math.abs(v) > 1e-9 ? `${i}:${+v.toFixed(3)}` : null).filter(Boolean).slice(0, 8);
      if (nzF.length) extra.push('floats ' + nzF.join(' '));
    }
    if (extra.length) console.log(`   ${extra.join('  ')}`);
    console.log('');
  }
  const idle = model.count - list.length;
  if (idle > 0) {
    console.log(`（另有 ${idle} 个槽位未从初始模式引用可达，未展示 —— 不代表文件损坏）`);
  }
  return 0;
}

function cmdVerify(args) {
  const input = positional(args, [])[0];
  if (!input) { console.error('缺少 .genome 文件'); return 1; }
  let bytes;
  try { bytes = readBytes(input); } catch (e) { console.error(`读取失败: ${e.message}`); return 1; }
  const errs = [];
  try {
    const isZip = L.isZip(bytes);
    if (!isZip && (bytes[0] !== 0xac || bytes[1] !== 0xed)) errs.push('缺少 Java 流头 AC ED 00 05，也不是 ZIP');
    const model = L.decodeGenome(bytes);
    if (model.container === 'raw' && model.count !== L.N_MODES) errs.push(`模式槽数量 ${model.count}（旧格式官方 ${L.N_MODES}）`);
    if (model.container === 'zip' && model.count < 1) errs.push('ZIP 版模式数为 0');
    const inits = model.modes.filter(m => m.isInitial).length;
    if (inits !== 1) errs.push(`初始模式数量 ${inits}（应为 1）`);
    model.modes.forEach((m, i) => {
      if (!L.TYPE_BY_ID.has(m.cellType)) errs.push(`M${i + 1} 细胞类型编号越界: ${m.cellType}`);
      if (m.child1Mode < 1 || m.child1Mode > model.count) errs.push(`M${i + 1} 子模式1 越界: ${m.child1Mode}`);
      if (m.child2Mode < 1 || m.child2Mode > model.count) errs.push(`M${i + 1} 子模式2 越界: ${m.child2Mode}`);
      const massCap = model.container === 'zip' ? 60 : 3.68;
      if (m.splitMass < -0.001 || m.splitMass > massCap) errs.push(`M${i + 1} 分裂质量异常: ${m.splitMass}`);
      m.color.forEach((c, j) => { if (c < -0.001 || c > 1.001) errs.push(`M${i + 1} 颜色通道${j}越界: ${c}`); });
    });
    console.log(`文件: ${input}  大小 ${bytes.length} 字节`);
    console.log(`格式: ${model.container === 'zip' ? 'ZIP 容器' : '裸 Java 流'} · v${model.fileVersion} · 每段 ${model.modeSize} 字节 · ${model.count} 槽`);
    console.log(`初始模式: M${L.initialIndexOf(model) + 1}`);
    console.log(errs.length ? `\n发现 ${errs.length} 个问题:` : '\n结构校验: 全部通过');
    errs.slice(0, 20).forEach(e => console.log('  - ' + e));
    return errs.length ? 2 : 0;
  } catch (e) {
    console.error(`校验失败: ${e.message}`);
    return 1;
  }
}

function cmdTree(args) {
  const input = positional(args, ['--depth'])[0];
  if (!input) { console.error('缺少配方或 .genome 文件'); return 1; }
  const depth = Number(flag(args, '--depth', 6));
  let model;
  try { model = loadModel(input); } catch (e) { console.error(`加载失败: ${e.message}`); return 1; }
  console.log(L.growthTree(model, { maxDepth: Number.isFinite(depth) ? depth : 6 }));
  return 0;
}

function cmdSim(args) {
  const input = positional(args, ['--max-cells'])[0];
  if (!input) { console.error('缺少配方或 .genome 文件'); return 1; }
  const maxCells = Number(flag(args, '--max-cells', 150));
  if (!Number.isFinite(maxCells) || maxCells < 1) { console.error('--max-cells 需要正整数'); return 1; }
  if (maxCells > 300) console.error('提示: 建议 150，最高 300，已按 300 截断');
  let model;
  try { model = loadModel(input); } catch (e) { console.error(`加载失败: ${e.message}`); return 1; }
  const sim = L.simulate(model, { maxCells: Math.min(maxCells, 300) });
  console.log(L.formatSimulation(sim, model, { maxCells: Math.min(maxCells, 300), showEvents: args.indexOf('--events') >= 0 }));
  return 0;
}

process.exitCode = main(process.argv.slice(2));
