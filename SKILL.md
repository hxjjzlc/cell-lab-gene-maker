---
name: cell-lab-gene-maker
description: "Build, read and repair .genome files for the mobile game Cell Lab. Handles both the legacy bare format (v95/v3055) and the Macro ZIP container (v3145/v3169). Draws growth trees and runs a structural simulation (connected bodies, composition ratios, flagella dying at birth, misalignment). Triggers: make a cell, build a genome, this genome will not open, import failed, convert format, what will this genome grow into, 做个细胞, 造个基因, 这个基因打不开, 导入失败, 转换格式."
license: MIT
---

# Cell Lab Gene Maker v2.1

Recipe JSON ↔ `.genome` binary, in both directions. **Both format generations are supported:**

| Gen | Container | Version | Segment | Notes |
|---|---|---|---|---|
| Legacy | bare Java stream (starts `AC ED 00 05`) | v95 / v3055 | 315 / 331 bytes | original Cell Lab: v95 = 40 slots, v3055 = 127 slots |
| Modern | **ZIP container** (`PK`, holds `save.bin` + `thumbnail.png`) | v3145 / v3169 | 1125 / 1212 bytes | Cell Lab: Macro; segment count = actual mode count |

**A given game build accepts one container type only.** Modern builds reject the legacy stream as "unrecognized file"; legacy builds cannot read the ZIP. That mismatch is the usual cause of "import failed" — pick the right `--format` in `make`.

Legacy output has been verified byte-for-byte in both directions against four real samples. The modern format has been verified on three real Macro samples for reading, repacking and generation.

## Commands

```bash
node cli.js make   <recipe.json> -o <out.genome> [--format modern|raw] [--template <real-sample.genome>]
node cli.js read   <file.genome> [--json]     # parse, auto-detects the generation
node cli.js verify <file.genome>              # structural check
node cli.js tree   <recipe.json|file.genome> [--depth N]
node cli.js sim    <recipe.json|file.genome> [--max-cells N]
node cli.js types                             # cell type table
node cli.js presets                           # built-in recipes
```

`tree` / `sim` / `read` detect the generation automatically and accept both.

## Choosing the format

- **Cell Lab: Macro** (the 2026 rebuild) → `--format modern`
- **Original Cell Lab** (Petter Säterskog's build, or an old APK) → default (bare stream)
- Unsure → `read` a genome you exported from your own copy of the game and check the first line of output ("ZIP container" or "bare Java stream")

The safest route is to use a real export as the template:

```bash
node cli.js make recipe.json -o out.genome --template sample.genome
```

`--template` inherits the container type, version number, segment length and tail structure (plus the thumbnail, in the modern format) and replaces only the fields your recipe names.

## Recipe format

```json
{
  "format": "modern",
  "name": "simple swimmer",
  "modes": [
    { "type": "phagocyte",    "color": [0.75,0.9,0.35], "splitMass": 2.5, "children": [1,2], "makeAdhesin": true },
    { "type": "flagellocyte", "color": [0.95,0.55,0.2], "splitMass": 3.6, "swimForce": 0.6, "children": [1,2] }
  ]
}
```

- `format`: `"modern"` or `"raw"`; `--format` overrides it. When omitted, a template decides; without one, legacy.
- Modern **segment count = number of modes written**; nothing needs padding to 127. Legacy pads to 127 slots automatically.

Per mode (defaults apply when a field is omitted):

| Field | Range | Default | Notes |
|---|---|---|---|
| `type` | see `types` | phagocyte | cell type: key, index or name |
| `color` | `[r,g,b]` 0..1 or `"#ff8800"` | black | |
| `splitMass` | **0.648..3.672** ng (legacy) / not validated in modern (lipocytes reach 12 ng) | 2.538 | **3.672 = never divides** |
| `splitRatio` | 0.1..0.9 | 0.5 | mass split between children |
| `splitAngle` | 0..360° | 0 | split axis relative to the cell's front |
| `child1Angle` / `child2Angle` | 0..360° | 0 | child facing, relative to the split axis |
| `children` | `[child1, child2]` | self | child mode numbers (1-based); out of range is an error |
| `makeAdhesin` | bool | **false** | whether the children stick together |
| `child1KeepAdhesin` / `child2KeepAdhesin` | bool | true / true | inherit the parent's connections |
| `priority` | 0.01..100 | 1 | nutrient priority |
| `adhesinStiffness` | 0..1 | 0 | adhesion stiffness |
| `maxConnections` | 1..20 | 20 | stops dividing once full |

Per-type fields: `swimForce` (flagellum 0..1), `density` (buoyancy −3..3), `muscleBend/Contract/Lift`, `stemThreshold1/2`, `secreteType`, `smell*`, `signals` (neuro −20..20), `virusFrom/virusTo`, `values`.

**These per-type fields only take effect in the legacy format.** The modern extension area (past byte 67 of a segment) is not parsed here; see Known limits.

## Modern (Macro) segment layout

Reversed from `classes.dex` (`Gene.o()` writes, `Gene.l()` reads), then checked field by field against 86 segments from three real samples. **What the 1212 bytes contain:**

| Offset | Length | Content |
|---|---|---|
| 0–3 | 4 | segment version |
| 4–15 | 12 | colour r/g/b |
| 16–19 | 4 | split mass (stored as ng/10) |
| 20–23 | 4 | split ratio |
| 24–35 | 12 | split angle, child1 angle, child2 angle (radians) |
| 36–39 | 4 | nutrient priority |
| 40–43 | 4 | child mode 1 (stored as index−1) |
| 44–47 | 4 | child mode 2 |
| 48–50 | 3 | adhesin / child1 keeps / child2 keeps |
| 51–54 | 4 | cell type |
| 55–58 | 4 | reserved |
| 59–65 | 7 | seven booleans: `[1]` = initial mode, `[0]` always true, `[2][3]` = mirrors |
| 66–77 | 12 | three ints |
| 78–82 | 5 | five booleans |
| 83–90 | 8 | two floats (`[0]` = adhesin stiffness) |
| 91–362 | 272 | **`Value[17]`**, 16 bytes each `{int16 input, int16 form, float a,b,c}` |
| 363–426 | 64 | **`int[16]`** (`[7]` = max connections, stored as the UI value) |
| 427–510 | 84 | **`float[21]`** |
| 511–end | — | ten 65-byte per-type parameter blocks, 99% identical across segments, preserved verbatim |

`Value` semantics match legacy: `[0]` swim force, `[1]` density, `[2..4]` muscle bend/contract/lift, `[5][6]` stem thresholds, `[7..10]` four signal outputs, `[11..16]` new Macro slots.

**What that means**: apart from the ten type blocks after byte 511, every modern parameter can be read and written. A flagellum thrust bound to S2/S3 is `values[0].input` and `.form`, and can be written straight from the recipe:

```json
{ "type": "flagellocyte", "swimForce": 0.8,
  "values": [ { "input": "s4", "form": "threshold", "a": 0, "b": -0.44, "c": 0 } ] }
```

(`values` with 17 entries replaces the whole table; with 11 entries it is treated as legacy and fills the first 11 slots.)

## Cell types

The number is `cellType` in the file. **18 originals, order fixed:**

| # | key | what it does | cost ng/h |
|---|---|---|---|
| 0 | phagocyte | eats nutrient particles | 1 |
| 1 | flagellocyte | flagellar propulsion | by thrust |
| 2 | photocyte | makes energy in light | 2.5 |
| 3 | devorocyte | sticks to other cells and drains them | — |
| 4 | lipocyte | stores energy (cap 21.6 ng) | 0.03 |
| 5 | keratinocyte | armour | — |
| 6 | buoyocyte | density control (positive sinks, negative floats) | — |
| 7 | glueocyte | sticks on contact (up to 5 connections) | — |
| 8 | virocyte | injects genes, converts the target | — |
| 9 | nitrocyte | produces nitrogen, moves it over adhesin only | — |
| 10 | stereocyte | left/right smell difference (steering) | — |
| 11 | senseocyte | senses concentration | — |
| 12 | myocyte | contract / bend / lift | 0 |
| 13 | neurocyte | four signal outputs | — |
| 14 | secrocyte | secretes substance or signal | — |
| 15 | stemocyte | differentiates when signal > 0.5 | — |
| 16 | gamete | fusion reproduction, never divides | 0.03 |
| 17 | ciliocyte | cilia swimming left/right | 0.03 |

`node cli.js types` prints the full table (mechanics, dedicated parameter slots, UI mapping); `types --json` for machines. Per-type mechanics, immunity and parameter ranges live in `references/classic-mechanics.md`.

### Legacy hard rules

- Normal cells cap at **3.6 ng**, lipocytes at **21.6 ng** (3.6 body + 18 fat). Priority counts total mass, so a lipocyte behaves like 6x.
- Division needs all four: age ≥ 0.5 h, mass ≥ threshold, **nitrogen ≥ 20%**, connections below the limit. Stuck and not splitting? Check nitrogen first.
- The split-mass slider cannot reach 3.672. Writing 12.2 / 21.6 means "never divides" — do not carry Macro egg-stage masses into legacy.
- Functional cells (neuro, sense, stereo, flagellum, glue, keratin) cannot feed: always 3.672.
- Flagellum facing = **split angle + child angle**, summed. Born against a sister cell, it dies on the spot.
- Gametes do not divide, they only fuse (after 0.5 h; the larger one sets the mode).
- Viruses copy only two generations along the lineage; aimed outside it, nothing divides.

### Macro additions (modern only)

Numbering not yet confirmed against the game: Gangliocyte (logic gates: condition/branch/output rules), Luxocyte (light), Cnidocyte (contact-triggered), Embryocyte (quad split), Progenocyte (path/threshold), Rhizocyte (self-stick/targeted), Scopocyte, Somatocyte (inheritance), Gluocyte (deformation), Adipocyte (new fat lineage).

Unknown numbers read back as "type N (Macro)" — use `read --json` for the raw `cellType` and match it against the order shown in game.

## Growth tree `tree`

```
M1 phagocyte · 2.5ng
├─ (50%) M1 phagocyte · 1.25ng  ↻ same mode on this path, stop
└─ (50%) M2 flagellocyte · 1.25ng  ■ never divides
```

Three terminal states: the same mode reappears on the current path (↻ recursion guard), `splitMass=3.672` (■ never divides), `--depth` reached (default 6).

Every node carries a one-line hint for its type: thrust, density, muscle action, secretion, sense channel, virus target, stem direction, fat cap. That is where "flagellum with zero thrust" or "secrocyte secreting nutrient instead of signal" surfaces while you read.

## Structural simulation `sim`

```bash
node cli.js sim presets/swimmer.json --max-cells 150
```

Infinite light and food; runs until the growth chain ends or the cap is hit. **150 recommended, 300 maximum.**

Prints connected bodies (adhesin components), composition per body (sums to 100%; single unconnected cells get no ratio), flagella dying at birth, and overlap/misalignment warnings.

**A geometric approximation, not a physics engine**: no thrust, no fluid, no soft-body deformation, no starvation. It answers exactly one question — how many bodies this rule set ends up with, and what each is made of. Legacy parameters are aligned: lipocytes reach 21.6 ng, gametes never divide, flagella born into a sister cell are flagged.

**Geometry convention**: `child1` sits on the positive side of the split axis, `child2` on the other. When simulation and game disagree, swap the two `children` values and retry.

## Before delivery

Four steps, none optional, before any genome file leaves the bench:

1. Run `tree` and read every level yourself: is some mode recursing into an endless snake, is a part that should survive turning into something else at birth.
2. Run `sim` and look at **composition per body**, not just how many bodies. Missing parts, extra parts, half a body swallowed — all of it shows up in the composition.
3. Compare with intent: what each slot was meant to do, and whether the tree actually does that.
4. Show the tree to whoever asked for the genome. A conclusion drawn without reading the tree is not a conclusion.

## Presets

Four recipes in `presets/`, all legacy-compatible (`dist/` holds them compiled):

| File | What it is | Mechanisms used |
|---|---|---|
| `swimmer.json` | phagocyte + flagellum, the smallest moving individual | assembly splitting, functional cells at 3.672 |
| `colony.json` | one photocyte stacking itself into a colony | autotrophic core |
| `predator.json` | devorocyte + flagellum, chases other cells | contact feeding |
| `amphibious.json` | stemocyte differentiating into two forms by environment | differentiation threshold |

## Design principles (read before building)

A genome is not "eight parts strung in a row". It is "whoever can grow, does the splitting".

1. **Decide who can accumulate mass.** Phagocytes (eat particles), photocytes (energy from light) and lipocytes (fed by neighbours) can grow. Neuro, sense, stereo, flagellum, glue and keratin cannot feed and are burning energy themselves.
2. **Functional cells always get `splitMass: 3.672`.** Give a neuro or flagellum 1.3 or 1.8 and, at equal priority, it never reaches the threshold; even if it does, it splits into two more functional cells that still cannot eat.
3. **The body is assembled, not grown.** Let feeding or photosynthesising cells act as the assembly part: each level splits once, the children immediately switch to a terminal mode, and the assembly part is consumed — which is why the chain does not run forever.
4. **Eggs must be laid outward.** The `splitAngle` of the laying mode has to point out of the body, and the egg keeps no adhesin. A parent with its own angle passes that angle to the child, which then lays inside the body, where the egg jams or grows deformed.
5. **Depth is cost.** Each extra level from the initial mode to the flagellum is one more round of development. Three levels to a flagellum is workable; at four, only the trunk is left worth looking at.
6. **Priority decides who eats first.** Energy and storage 1.0–2.5, assembling phagocytes around 1.0, functional cells 0.2–0.4.
7. **A virus cannot build a whole individual.** Virus copying reaches only parent/child/grandchild, so "an individual that releases viruses" cannot grow from nothing that way. One workable answer is to push the flagellum's split mass down to 2.5–3.5 instead of 3.672: normally it never splits; once it touches a glueocyte and takes nutrient by priority, it crosses the threshold and splits into a complete unit. Three conditions must hold at once — the glueocyte feeds by priority, the splitting branch has a raised priority, and the other flagella's consumption keeps the split from finishing too early (so the mass cannot be so low that it splits at birth).
8. **The main body must be a phagocyte.** Chasing food, draining, handing out nutrient — all of it runs on the phagocyte. Flagella attach to phagocytes, not to photocytes: the flagellum's job is to push the phagocyte into food and pass energy back. A node with a photocyte driving a flagellum is a cart with no engine.
9. **A photocyte is a power supply, not a body.** Priority down to 0.1, mass near the cap, `stayAlive` on: it does not die, does not compete for nutrient, does not split, and feeds the neighbouring phagocyte. Once displaced it slowly grows back to threshold and splits into two flagella that self-destruct and recycle. On the egg side the split keeps no adhesin, so the photocyte is pushed out.
10. **A flagellum is judged by the combined angle.** Facing = `splitAngle + childAngle`. `splitAngle 90° + childAngle 0°` is a combined 90°, straight out to the side; a lone `childAngle` of 0 does not mean it is wrong. Compute the combined angle against where the sister cell sits before changing anything.

## Field pitfalls

Things the recipe does not show and only a real run reveals. All of these came out of actual genomes.

- **Bolting reproduction onto an official fish**: some cells' split mass plus storage leaves the new cell one bite short, so it stops the instant it splits and the chain dies there. Leave headroom in the laying mode's split mass; do not sit on the mass cap.
- **An egg needs nutrient to detach**: if it has not stored enough at the moment of separation, it lands and cannot grow. Let the egg fill before it leaves, or raise the egg's `priority` separately.
- **Throttle the laying**: give the laying mode `maxConnections: 2` (one to the parent, one to the egg). Full means no split, and the slot frees up when the egg leaves. Without it, it lays again while the old egg is still filling and shoves that one out.
- **Twelve at once**: the parent is spent after the split; it is a one-shot burst. To keep it sustainable, the parent needs a supply line that does not divide (photocyte or lipocyte).
- **Keep one sterile worker**: after two cleavage steps, switch to a `splitMass: 3.672` phagocyte that only eats and never splits, feeding the colony. With reproduction and feeding on separate lines, the whole chain does not starve at once.
- **A virus only copies modes inside the lineage**: parent, child, grandchild. Pointed outside, that branch never divides.
- **A compressed neurocyte is squeezed, not configured**: sandwiched between two large cells, `cytoskeleton` 0.5, `adhesinLength` 0, it flattens.
- **Direction**: swap `children` and the two angles as a pair; the game normalises child1 to the 0° side, so re-export after import to see how it landed.
- **`form` in modern `values`**: `form: 0` is a constant, `form: 1` means "driven by the input signal". The fish's flagellum is `input:3 (s4) / form:1 / b:-0.44`. Written as `form:0` it becomes a fixed thrust, which looks like "the flagellum stopped steering".
- **The initial mode must feed itself**: start with a lipocyte or phagocyte in a lit dish and it may never accumulate enough for the first split (it looks like "it only splits when it hits a wall"). A photocyte as the initial mode is the safe choice.
- **Modern builds need a template**: after byte 511 sit ten per-type parameter blocks. A fresh build leaves them zeroed and colours and some behaviour come out wrong. `--template` with your own export is the stable route.
- **`values` takes 11 or 17 entries only**; copying the single-entry example from the docs verbatim is a hard error.
- **`sim` reads modern `maxConnections` from the wrong slot** (legacy `ints[9]` ↔ modern `ints[7]`), so a modern model may report "nothing ever divides". Do not trust that number.
- **Never let functional cells divide.** Neuro, sense and flagellum cannot feed; at equal priority they never reach the threshold, and a lowered threshold only makes them retry and burn energy on the way. Even when one does split, the products are two functional cells that still cannot eat.
- **Any angle on a laying cell has to be computed.** The parent's `splitAngle` is inherited by the child; leave it alone and eggs go inside the body.
- **A flagellum angle of 0 is wasted.** When a flagellum is the child of a split, that child's angle should be 180° so it points backwards; at 0 it points into the sister cell and the game kills it at birth (`sim` reports "flagellum blocked by sister cell").
- **Side laying needs a fold-back.** To lay at 90°, give the egg's child angle 270°, or the next generation keeps drifting at 90°.
- **Flagellum thrust defaults to a signal.** A flagellum cloned from a sample keeps `swimForce` as `form:1` bound to s4; with no signal source in the genome thrust is ~0, which looks like "the flagellum is there but does not push". Either give it a signal or rewrite `values[0]` as `form:0 + b:0.8` constant.
- **Read `sim` for composition, not fragment count.** When a flagellum is swallowed, `sim` reports "dies at birth", but the number to watch is the composition of each body; counting bodies alone hides half a flagellum going missing.

## Modern workflow: clone from a real sample

The 0.2-era loader validates mode identity. A direct recipe build (`make --format modern`) shows up on a device as "imports fine, tree renders, crashes the moment you enter the dish". The reason: **the single byte at offset 1174 of each segment is the mode identity** and must be globally unique; a direct build gives every segment the same template bytes, so all identities collide.

The flow that survives a real device:

1. Take a genome exported from your own copy of the game as the master (its segments are legal by construction).
2. For each mode, pick a master segment of the same cell type (photocyte from a photocyte segment, flagellum from a flagellum segment) and copy the whole segment.
3. Change only the first 67 bytes: colour 4–15, split mass 16 (stored as ng/10), ratio 20, three angles 24–35 (radians), priority 36, child modes 40/44 (stored as index−1), adhesin and keep flags 48–50, type 51, initial flag 60. Everything else (values / ints / floats / the type blocks after 511) stays.
4. **Write a unique identity byte at offset 1174** (1..N is enough). Skip this and the crash is guaranteed.
5. Copy the trailing 52 bytes from the master; assemble `int32 version + int32 count + segments × N + 52`.
6. Package the ZIP: `save.bin` first, `mode_names.json` second, entry count = segment count.

After deleting a segment, put any out-of-range child modes back to legal values.

## Importing into the game

1. Copy the `.genome` to the phone.
2. Game → **Lab → Gene editor → Load → From file**.
3. Macro moved the UI around; if that path is missing, tap the file directly in the genome list.

## Troubleshooting

| Symptom | Fix |
|---|---|
| **"Unrecognized file" on import** | Almost always the generation. Modern builds want the ZIP container: `make ... --format modern`; legacy builds want the bare stream: `make ... --format raw` |
| Parameters wrong after importing on modern | Check `values` / `ints` / `floats`; the three tables are ordered differently between generations, so only `values` should be mapped across formats |
| Legacy import crashes the game | `--template <your-export>.genome` to align version, slot count and segment length |
| Cells do not move | Check whether `makeAdhesin` is false, and whether the flagellum is stuck behind its `splitMass` |
| It grows into a mess | Set non-core modes to `splitMass: 3.672` to cut the chain |
| Many flagella die at birth in simulation | The flagellum points into its sister cell: move it to `child2` or add 180° to `child2Angle` |
| Simulation produces many fragments | Connections break: check `child1KeepAdhesin` / `child2KeepAdhesin` and `maxConnections` |
| **Imports fine, crashes entering the dish** | Two checks on modern: is the mode identity byte (offset 1174) duplicated; were segments cloned from a real sample. A direct recipe build always crashes |

## Technical notes (read before touching the code)

**Legacy**: `AC ED 00 05` + 1024-byte blocks (full block `0x7A` + int32; tail block `0x77` + 1 byte, and a tail of 256 bytes or more **must** still use `0x7A`) + `int32 version` + N segments. Segment 315 bytes (v95) / 331 bytes (v3055).

**Modern**: an ordinary ZIP (deflate or stored) holding `save.bin` / `thumbnail.png` / optional `mode_names.json`. `save.bin` is again a Java stream shell; the payload is `int32 version` + **`int32 mode count`** + N segments + a 52-byte tail (`int32 16` + 16 × `01 00 00`). Segment length is located by "every segment starts with the version number" (v3145 = 1125, v3169 = 1212).

The first 67 bytes are isomorphic across generations: `version, color[3], splitMass (stored as ng/10), splitRatio, splitAngle, child1Angle, child2Angle, priority, child1Mode, child2Mode, makeAdhesin, c1Keep, c2Keep, cellType, reserved, stayAlive, isInitial, mirror1, mirror2, adhesinStiffness`.

- Legacy, after byte 67: `Value[11]{int16 input,int16 form,float a,b,c}` + `int32[11]` + `float[7]` + an optional 16-byte extension.
- Modern layout is the table above; segment length 1125 (v3145) / 1212 (v3169), first 511 bytes isomorphic with legacy.
- `int32[9]` (legacy) max connections stores the UI value − 1.
- Angles are radians; the programmable value's `b` stores the slider position normalised to `[-1,1]`.
- Mass slider step is 0.018 ng; normal cells cap at 3.6 ng, lipocytes higher (12.2 ng seen in samples).
- ZIP read/write is pure JS (including RFC1951 inflate), no zlib dependency, so it runs on a phone's embedded JS engine too.
