// The drawings of the approved sketches (S1-S15, 17 Oct): one "take it like this" drawing per photo step, and the
// icons. Drawings for now; real photos can replace them later, one at a time (swap the string for an <img>).
// PROOF uses the MEASURE drawings with the courier label stuck next to the slip.

const svg = (vb, label, body, w = '100%') => `<svg viewBox="${vb}" width="${w}" role="img" aria-label="${label}">${body}</svg>`;
const ic = (body, size = 22, sw = 2) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

// a small courier label with a barcode, for the PROOF versions of the drawings
const label = (x, y, w, h) => {
  const bars = Array.from({ length: Math.max(4, Math.floor((w - 8) / 3.2)) }, (_, i) => `M${(x + 4 + i * 3.2).toFixed(1)} ${y + 4}v${(h * 0.5).toFixed(1)}`).join('');
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" fill="#FFFFFF" stroke="#13202E" stroke-width="1.5"></rect>` +
    `<path d="${bars}" stroke="#13202E" stroke-width="1.6"></path><path d="M${x + 4} ${y + h * 0.75}h${w - 10}" stroke="#9AA6B4" stroke-width="2"></path>`;
};

const SLIP_SMALL = (x, y) => `<rect x="${x}" y="${y}" width="42" height="40" rx="2" fill="#FFFFFF" stroke="#13202E" stroke-width="1.5"></rect>` +
  `<rect x="${x + 4}" y="${y + 4}" width="14" height="4" fill="#13202E"></rect><rect x="${x + 24}" y="${y + 4}" width="14" height="4" fill="#13202E"></rect>` +
  `<path d="M${x + 4} ${y + 16}h30M${x + 4} ${y + 23}h24M${x + 4} ${y + 30}h28" stroke="#9AA6B4" stroke-width="2"></path>`;

export const D = {
  home: () => svg('0 0 320 190', 'A phone above a parcel, the paper on the parcel inside the camera frame',
    '<rect x="0" y="168" width="320" height="22" fill="#E9DFCC"></rect><rect x="40" y="96" width="240" height="72" rx="26" fill="#FFFFFF" stroke="#8796A8" stroke-width="2"></rect>' +
    '<path d="M110 98v68M210 98v68" stroke="#D5DCE4" stroke-width="2"></path><rect x="128" y="108" width="64" height="48" rx="2" fill="#FFFFFF" stroke="#13202E" stroke-width="2"></rect>' +
    '<rect x="134" y="114" width="22" height="5" fill="#13202E"></rect><rect x="166" y="114" width="20" height="5" fill="#13202E"></rect>' +
    '<path d="M134 128h40M134 135h34M134 142h44M134 149h28" stroke="#9AA6B4" stroke-width="2"></path>' +
    '<path d="M118 112v-12h12M190 100h12v12M202 150v12h-12M130 162h-12v-12" stroke="#E36414" stroke-width="3" fill="none" stroke-linecap="round"></path>' +
    '<rect x="146" y="10" width="30" height="50" rx="6" fill="#13202E"></rect><rect x="150" y="16" width="22" height="36" rx="2" fill="#9CC3F5"></rect>' +
    '<path d="M160 64v28" stroke="#E36414" stroke-width="2" stroke-dasharray="4 4"></path>'),

  askNo: () => svg('0 0 300 120', 'A parcel with only the packing slip on it',
    '<rect x="0" y="104" width="300" height="16" fill="#E9DFCC"></rect><rect x="30" y="34" width="240" height="70" rx="26" fill="#FFFFFF" stroke="#8796A8" stroke-width="2"></rect>' +
    '<rect x="118" y="44" width="64" height="50" rx="2" fill="#FFFFFF" stroke="#13202E" stroke-width="2"></rect><rect x="124" y="50" width="22" height="5" fill="#13202E"></rect>' +
    '<rect x="156" y="50" width="20" height="5" fill="#13202E"></rect><path d="M124 64h40M124 71h34M124 78h44M124 85h28" stroke="#9AA6B4" stroke-width="2"></path>'),

  askYes: () => svg('0 0 300 120', 'A parcel with the packing slip and a courier label with a barcode next to it',
    '<rect x="0" y="104" width="300" height="16" fill="#E9DFCC"></rect><rect x="30" y="34" width="240" height="70" rx="26" fill="#FFFFFF" stroke="#8796A8" stroke-width="2"></rect>' +
    '<rect x="70" y="44" width="64" height="50" rx="2" fill="#FFFFFF" stroke="#13202E" stroke-width="2"></rect><rect x="76" y="50" width="22" height="5" fill="#13202E"></rect>' +
    '<rect x="108" y="50" width="20" height="5" fill="#13202E"></rect><path d="M76 64h40M76 71h34M76 78h44M76 85h28" stroke="#9AA6B4" stroke-width="2"></path>' +
    '<rect x="146" y="40" width="84" height="58" rx="2" fill="#FFFFFF" stroke="#13202E" stroke-width="2"></rect>' +
    '<path d="M154 50v22M158 50v22M163 50v22M166 50v22M171 50v22M176 50v22M179 50v22M184 50v22M189 50v22M192 50v22M197 50v22M202 50v22M205 50v22M210 50v22M215 50v22M220 50v22" stroke="#13202E" stroke-width="2"></path>' +
    '<path d="M154 80h56M154 88h40" stroke="#9AA6B4" stroke-width="2"></path>'),

  slip: () => svg('0 0 320 190', 'The packing slip on the parcel, seen from above, the order number at the top right circled',
    '<rect x="14" y="10" width="292" height="170" rx="22" fill="#FFFFFF" stroke="#8796A8" stroke-width="2"></rect><path d="M40 12v166M280 12v166" stroke="#E4E9EF" stroke-width="2"></path>' +
    '<rect x="94" y="30" width="132" height="132" rx="3" fill="#FFFFFF" stroke="#13202E" stroke-width="2"></rect><rect x="104" y="40" width="50" height="9" fill="#13202E"></rect>' +
    '<rect x="176" y="40" width="40" height="7" fill="#13202E"></rect><rect x="190" y="51" width="26" height="5" fill="#9AA6B4"></rect>' +
    '<rect x="104" y="64" width="112" height="16" rx="2" fill="none" stroke="#C9772B" stroke-width="1.5"></rect>' +
    '<path d="M104 92h40M104 99h34M104 106h44M104 113h30M164 92h40M164 99h46M164 106h30" stroke="#9AA6B4" stroke-width="2"></path>' +
    '<path d="M104 126h112M104 134h80M104 142h96" stroke="#C9D2DC" stroke-width="2"></path><rect x="168" y="34" width="54" height="26" rx="7" fill="none" stroke="#E36414" stroke-width="3"></rect>' +
    '<path d="M84 40V22h18M218 22h18v18M236 152v18h-18M102 170H84v-18" stroke="#E36414" stroke-width="3" fill="none" stroke-linecap="round"></path>'),

  label: () => svg('0 0 320 150', 'Seen from above: the courier label stuck right next to the packing slip, both inside the camera frame; the slip\'s order number and the label\'s barcode are circled',
    '<rect x="8" y="6" width="304" height="138" rx="20" fill="#FFFFFF" stroke="#8796A8" stroke-width="2"></rect><rect x="34" y="24" width="110" height="104" rx="3" fill="#FFFFFF" stroke="#13202E" stroke-width="2"></rect>' +
    '<rect x="42" y="32" width="40" height="8" fill="#13202E"></rect><rect x="104" y="32" width="32" height="6" fill="#13202E"></rect>' +
    '<path d="M42 56h44M42 63h36M42 70h48M42 77h30M42 92h90M42 100h70M42 108h80" stroke="#9AA6B4" stroke-width="2"></path><rect x="98" y="26" width="44" height="18" rx="6" fill="none" stroke="#E36414" stroke-width="3"></rect>' +
    '<rect x="158" y="20" width="130" height="112" rx="3" fill="#FFFFFF" stroke="#13202E" stroke-width="2"></rect><path d="M168 32h60M168 40h44" stroke="#9AA6B4" stroke-width="2"></path>' +
    '<path d="M170 52v30M174 52v30M179 52v30M182 52v30M187 52v30M192 52v30M195 52v30M200 52v30M205 52v30M208 52v30M213 52v30M218 52v30M221 52v30M226 52v30M231 52v30M234 52v30M239 52v30M244 52v30M247 52v30M252 52v30M257 52v30M260 52v30M265 52v30M270 52v30M274 52v30" stroke="#13202E" stroke-width="2"></path>' +
    '<path d="M168 96h100M168 104h70M168 112h86M168 120h50" stroke="#9AA6B4" stroke-width="2"></path><rect x="162" y="46" width="118" height="42" rx="7" fill="none" stroke="#E36414" stroke-width="3"></rect>' +
    '<path d="M22 30V12h18M280 12h18v18M298 120v18h-18M40 138H22v-18" stroke="#E36414" stroke-width="3" fill="none" stroke-linecap="round"></path>'),

  scale: (proof) => svg('0 0 320 190', `The roll standing on its end, fully on the scale platform; the scale display reads 18.40 kg; both inside the camera frame${proof ? '; the label next to the slip' : ''}`,
    '<rect x="0" y="168" width="320" height="22" fill="#E9DFCC"></rect><rect x="64" y="152" width="122" height="16" rx="3" fill="#3C4650"></rect>' +
    '<rect x="94" y="22" width="62" height="130" rx="22" fill="#FFFFFF" stroke="#8796A8" stroke-width="2"></rect><path d="M96 56h58M96 124h58" stroke="#D5DCE4" stroke-width="2"></path>' +
    (proof ? SLIP_SMALL(104, 60).replace(/width="42"/, 'width="42"') + label(106, 104, 38, 30) : SLIP_SMALL(104, 70)) +
    '<path d="M186 160c14 0 22-4 30-12" stroke="#3C4650" stroke-width="2" fill="none"></path><rect x="214" y="104" width="6" height="64" fill="#3C4650"></rect>' +
    '<rect x="190" y="64" width="100" height="42" rx="6" fill="#1B2229"></rect><text x="232" y="93" text-anchor="middle" font-family="IBM Plex Mono, monospace" font-size="21" font-weight="600" fill="#7CF29A">18.40</text>' +
    '<text x="270" y="93" font-family="IBM Plex Mono, monospace" font-size="11" font-weight="600" fill="#7CF29A">kg</text>' +
    '<path d="M60 34V14h20M276 14h20v20M296 158v20h-20M80 178H60v-20" stroke="#E36414" stroke-width="3" fill="none" stroke-linecap="round"></path>'),

  length: (proof) => svg('0 0 320 190', `Side view: the roll lies on the floor with one end against the wall; the tape lies on top with zero at the wall; a black L-square stands at the far end touching the roll; the reading is where the tape meets the square, with the phone right above it${proof ? '; the label next to the slip' : ''}`,
    '<rect x="0" y="168" width="320" height="22" fill="#E9DFCC"></rect><rect x="0" y="0" width="22" height="168" fill="#DCE2E9"></rect>' +
    '<text x="30" y="26" font-family="Hind, sans-serif" font-size="13" fill="#4D5B6B">← दीवार</text><rect x="22" y="112" width="232" height="56" rx="26" fill="#FFFFFF" stroke="#8796A8" stroke-width="2"></rect>' +
    '<path d="M90 114v52M178 114v52" stroke="#E4E9EF" stroke-width="2"></path><rect x="114" y="122" width="38" height="32" rx="2" fill="#FFFFFF" stroke="#13202E" stroke-width="1.5"></rect>' +
    '<rect x="118" y="126" width="12" height="4" fill="#13202E"></rect><rect x="136" y="126" width="12" height="4" fill="#13202E"></rect><path d="M118 137h28M118 144h22" stroke="#9AA6B4" stroke-width="2"></path>' +
    (proof ? label(158, 122, 36, 32) : '') +
    '<rect x="22" y="103" width="232" height="9" fill="#F2C200" stroke="#B38F00" stroke-width="1"></rect><line x1="25" y1="105" x2="254" y2="105" stroke="#5A4A00" stroke-width="4" stroke-dasharray="1.2 6.8"></line>' +
    '<rect x="22" y="99" width="4" height="16" fill="#6B7785"></rect><text x="30" y="96" font-family="IBM Plex Mono, monospace" font-size="12" font-weight="600" fill="#13202E">0</text>' +
    '<rect x="254" y="62" width="8" height="106" fill="#1E1E1E"></rect><rect x="254" y="160" width="58" height="8" fill="#1E1E1E"></rect>' +
    '<text x="268" y="80" font-family="Hind, sans-serif" font-size="13" fill="#4D5B6B">स्क्वायर</text><circle cx="254" cy="107" r="14" fill="none" stroke="#E36414" stroke-width="3"></circle>' +
    '<rect x="240" y="2" width="28" height="44" rx="5" fill="#13202E"></rect><rect x="243" y="7" width="22" height="32" rx="2" fill="#9CC3F5"></rect><path d="M254 48v42" stroke="#E36414" stroke-width="2" stroke-dasharray="4 4"></path>'),

  breadth: (proof) => svg('0 0 320 190', `Seen from the end: the roll's long side is against the wall; the tape goes across the top with zero at the wall; the L-square stands on the other side touching the roll; the reading is where the tape meets the square, with the phone right above it${proof ? '; the label in view' : ''}`,
    '<rect x="0" y="168" width="320" height="22" fill="#E9DFCC"></rect><rect x="0" y="0" width="22" height="168" fill="#DCE2E9"></rect>' +
    '<circle cx="72" cy="120" r="48" fill="#FFFFFF" stroke="#8796A8" stroke-width="2"></circle><circle cx="72" cy="120" r="32" fill="none" stroke="#E4E9EF" stroke-width="2"></circle><circle cx="72" cy="120" r="16" fill="none" stroke="#E4E9EF" stroke-width="2"></circle>' +
    (proof ? label(48, 100, 34, 26) : '') +
    '<rect x="22" y="63" width="98" height="9" fill="#F2C200" stroke="#B38F00" stroke-width="1"></rect><line x1="25" y1="65" x2="120" y2="65" stroke="#5A4A00" stroke-width="4" stroke-dasharray="1.2 6.8"></line>' +
    '<rect x="22" y="59" width="4" height="16" fill="#6B7785"></rect><text x="30" y="56" font-family="IBM Plex Mono, monospace" font-size="12" font-weight="600" fill="#13202E">0</text>' +
    '<rect x="120" y="40" width="8" height="128" fill="#1E1E1E"></rect><rect x="120" y="160" width="58" height="8" fill="#1E1E1E"></rect>' +
    '<text x="136" y="118" font-family="Hind, sans-serif" font-size="13" fill="#4D5B6B">← स्क्वायर</text><circle cx="120" cy="67" r="14" fill="none" stroke="#E36414" stroke-width="3"></circle>' +
    '<rect x="106" y="0" width="28" height="42" rx="5" fill="#13202E"></rect><rect x="109" y="5" width="22" height="30" rx="2" fill="#9CC3F5"></rect><path d="M120 44v8" stroke="#E36414" stroke-width="2" stroke-dasharray="4 4"></path>' +
    '<text x="200" y="40" font-family="Hind, sans-serif" font-size="13" fill="#4D5B6B">सिरे की तरफ़ से</text><text x="200" y="56" font-family="Hind, sans-serif" font-size="12" fill="#4D5B6B">seen from the end</text>'),

  height: (proof) => svg('0 0 320 190', `The tape stands straight beside the roll with zero on the floor; the L-square's long arm lies across the top of the roll and its short arm hangs down against the tape; the reading is where the arm meets the tape, with the phone level with it${proof ? '; the label in view' : ''}`,
    '<rect x="0" y="168" width="320" height="22" fill="#E9DFCC"></rect><circle cx="100" cy="120" r="48" fill="#FFFFFF" stroke="#8796A8" stroke-width="2"></circle>' +
    '<circle cx="100" cy="120" r="32" fill="none" stroke="#E4E9EF" stroke-width="2"></circle><circle cx="100" cy="120" r="16" fill="none" stroke="#E4E9EF" stroke-width="2"></circle>' +
    (proof ? label(76, 104, 34, 26) : '') +
    '<rect x="160" y="30" width="9" height="138" fill="#F2C200" stroke="#B38F00" stroke-width="1"></rect><line x1="162" y1="32" x2="162" y2="166" stroke="#5A4A00" stroke-width="4" stroke-dasharray="1.2 6.8"></line>' +
    '<rect x="156" y="164" width="17" height="4" fill="#6B7785"></rect><text x="178" y="164" font-family="IBM Plex Mono, monospace" font-size="12" font-weight="600" fill="#13202E">0</text>' +
    '<rect x="70" y="64" width="107" height="8" fill="#1E1E1E"></rect><rect x="169" y="64" width="8" height="54" fill="#1E1E1E"></rect>' +
    '<text x="62" y="54" font-family="Hind, sans-serif" font-size="13" fill="#4D5B6B">स्क्वायर</text><circle cx="164" cy="72" r="14" fill="none" stroke="#E36414" stroke-width="3"></circle>' +
    '<rect x="248" y="50" width="28" height="44" rx="5" fill="#13202E"></rect><rect x="251" y="56" width="22" height="32" rx="2" fill="#9CC3F5"></rect><path d="M244 72h-62" stroke="#E36414" stroke-width="2" stroke-dasharray="4 4"></path>'),

  boxes: () => svg('0 0 320 150', 'Every box of the order side by side, each label facing the camera',
    '<rect x="0" y="130" width="320" height="20" fill="#E9DFCC"></rect><rect x="20" y="40" width="130" height="90" rx="10" fill="#FFFFFF" stroke="#8796A8" stroke-width="2"></rect>' +
    '<rect x="170" y="48" width="130" height="82" rx="10" fill="#FFFFFF" stroke="#8796A8" stroke-width="2"></rect>' + label(60, 62, 50, 40) + label(210, 66, 50, 40) +
    '<path d="M10 30V12h18M292 12h18v18M310 120v18h-18M28 138H10v-18" stroke="#E36414" stroke-width="3" fill="none" stroke-linecap="round"></path>'),

  keepAside: () => svg('0 0 200 130', 'Move the parcel to the side',
    '<rect x="0" y="112" width="200" height="18" fill="#D9982A"></rect><rect x="18" y="62" width="104" height="50" rx="20" fill="#FFFFFF" stroke="#2A1A00" stroke-width="2.5"></rect>' +
    '<rect x="50" y="72" width="34" height="28" rx="2" fill="#FFFFFF" stroke="#2A1A00" stroke-width="1.5"></rect><path d="M134 70h46M168 58l12 12-12 12" stroke="#2A1A00" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"></path>' +
    '<path d="M150 20h34v34" stroke="#2A1A00" stroke-width="3" fill="none" stroke-dasharray="5 5"></path>', '200'),
};

// The photo-blur picture of the retake screen (S9).
export const BLURRED = svg('0 0 320 150', 'The photo just taken, blurred',
  '<defs><filter id="ppblur"><feGaussianBlur stdDeviation="3.5"></feGaussianBlur></filter></defs><rect x="0" y="0" width="320" height="150" rx="12" fill="#E9DFCC"></rect>' +
  '<g filter="url(#ppblur)"><rect x="30" y="70" width="210" height="56" rx="26" fill="#FFFFFF"></rect><rect x="30" y="61" width="210" height="9" fill="#F2C200"></rect>' +
  '<rect x="240" y="26" width="8" height="104" fill="#1E1E1E"></rect><rect x="240" y="122" width="56" height="8" fill="#1E1E1E"></rect><rect x="112" y="80" width="38" height="30" fill="#FFFFFF" stroke="#13202E" stroke-width="2"></rect></g>');

// Icons (24x24, stroke = currentColor).
export const I = {
  slip: (s) => ic('<rect x="6" y="3" width="12" height="18" rx="1.5"></rect><path d="M9 8h6M9 12h6M9 16h4"></path>', s),
  label: (s) => ic('<rect x="3" y="5" width="18" height="14" rx="1.5"></rect><path d="M7 9v6M10 9v6M12 9v6M15 9v6M17 9v6"></path>', s),
  scale: (s) => ic('<path d="M3 20h18l-2.5-8h-13z"></path><rect x="9" y="4" width="6" height="5" rx="1"></rect><path d="M12 9v3"></path>', s),
  length: (s) => ic('<path d="M3 12h18M6.5 8.5 3 12l3.5 3.5M17.5 8.5 21 12l-3.5 3.5"></path>', s),
  breadth: (s) => ic('<circle cx="12" cy="14" r="6"></circle><path d="M3 5h18M5.5 3 3 5l2.5 2M18.5 3 21 5l-2.5 2"></path>', s),
  height: (s) => ic('<path d="M12 3v18M8.5 6.5 12 3l3.5 3.5M8.5 17.5 12 21l3.5-3.5"></path>', s),
  boxes: (s) => ic('<path d="M3 8l9-5 9 5v8l-9 5-9-5z"></path><path d="M3 8l9 5 9-5M12 13v8"></path>', s),
  camera: (s = 46) => ic('<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"></path><circle cx="12" cy="13" r="4"></circle>', s),
  arrow: (s = 40) => ic('<path d="M5 12h14M13 6l6 6-6 6"></path>', s, 2.5),
  lock: (s = 22) => ic('<rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V8a4 4 0 0 1 8 0v3"></path>', s),
  check: (s = 48) => ic('<path d="M5 12.5 10 17l9-10"></path>', s, 3),
  info: (s = 24) => ic('<circle cx="12" cy="12" r="9"></circle><path d="M12 8h.01M11 12h1v5h1"></path>', s),
  cloud: (s = 20) => ic('<path d="M7 18a4 4 0 0 1-.5-8 6 6 0 0 1 11.5 1.5A3.5 3.5 0 0 1 17.5 18z"></path><path d="M12 15v-5M9.5 12.5 12 10l2.5 2.5"></path>', s),
  person: (s = 22) => ic('<circle cx="12" cy="8" r="4"></circle><path d="M4 21a8 8 0 0 1 16 0"></path>', s),
  speaker: (s = 20) => ic('<path d="M4 9h4l5-4v14l-5-4H4z"></path><path d="M16 9a4 4 0 0 1 0 6"></path>', s),
  buzz: (s = 34) => ic('<rect x="8" y="3" width="8" height="18" rx="2"></rect><path d="M4 8v8M2 10v4M20 8v8M22 10v4"></path>', s),
  buzzLong: (s = 18) => ic('<rect x="8" y="3" width="8" height="18" rx="2"></rect><path d="M4 9v6M20 9v6"></path>', s),
  moon: (s = 24) => ic('<path d="M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9z"></path>', s),
  sun: (s = 24) => ic('<circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5"></path>', s),
  sheet: (s = 28) => ic('<rect x="4" y="3" width="16" height="18" rx="2"></rect><path d="M8 8h8M8 12h8M8 16h5"></path>', s),
  again: (s = 42) => ic('<path d="M20 11a8 8 0 1 0-2.3 5.7"></path><path d="M20 5v6h-6"></path>', s, 2.2),
  plusBox: (s = 34) => ic('<path d="M3 8l9-5 9 5v8l-9 5-9-5z"></path><path d="M12 9v6M9 12h6"></path>', s),
  keyboard: (s = 28) => ic('<rect x="2" y="6" width="20" height="12" rx="2"></rect><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"></path>', s),
  release: (s = 28) => ic('<path d="M3 8l9-5 9 5v8l-9 5-9-5z"></path><path d="M9 12l2 2 4-4"></path>', s),
  cancel: (s = 28) => ic('<circle cx="12" cy="12" r="9"></circle><path d="M8.5 8.5l7 7M15.5 8.5l-7 7"></path>', s),
  gear: (s = 28) => ic('<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"></path>', s),
  stopSign: (s = 124) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 2h8l6 6v8l-6 6H8l-6-6V8z" fill="#FFFFFF"></path><path d="M8.5 8.5l7 7M15.5 8.5l-7 7" stroke="#C2281F" stroke-width="2.6" stroke-linecap="round"></path></svg>`,
};
