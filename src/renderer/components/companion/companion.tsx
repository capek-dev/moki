import { useId } from 'react';
import type { Appearance } from '@shared/appearance';

export const PALETTES = {
  lavender: { light: '#f3eaff', body: '#c3a4e5', shade: '#9975bb', accent: '#76518f' },
  peach: { light: '#fff1db', body: '#f2bb9d', shade: '#d68b7d', accent: '#a75f61' },
  mint: { light: '#edfae8', body: '#a8d5c1', shade: '#73aa9e', accent: '#437e79' },
  sky: { light: '#eaf6ff', body: '#a6c9e7', shade: '#759cce', accent: '#516fa5' },
};
export type Mood = 'idle' | 'thinking' | 'working' | 'attention' | 'done' | 'speaking';
export { INITIAL_APPEARANCE, type Appearance } from '@shared/appearance';

const BODIES = {
  pebble: 'M49 130 C43 79 70 47 120 47 C170 47 197 79 191 130 C187 172 161 190 120 190 C79 190 53 172 49 130Z',
  mochi: 'M39 139 C40 105 65 67 120 67 C175 67 200 105 201 139 C204 176 166 190 120 190 C74 190 36 176 39 139Z',
  puff: 'M46 137 C27 116 39 82 61 77 C64 47 99 35 120 51 C145 35 177 49 180 77 C207 86 208 115 194 137 C201 171 164 196 120 187 C78 199 40 174 46 137Z',
};

function Head({ appearance }: { appearance: Appearance }) {
  const p = PALETTES[appearance.palette];
  return <g data-head={appearance.head} strokeLinecap="round" strokeLinejoin="round">
    {appearance.head === 'sprout' && <g stroke="#56826b" strokeWidth="3"><path d="M120 57 Q119 41 128 29" fill="none" /><path d="M122 43 Q95 44 99 26 Q119 24 122 43" fill="#a0c890" /><path d="M124 37 Q124 15 144 18 Q147 36 124 37" fill="#bcd99b" /></g>}
    {appearance.head === 'cat-ears' && <><path d="M69 69 L70 31 L99 53Z" fill={p.body} stroke={p.shade} strokeWidth="2" /><path d="M171 69 L170 31 L141 53Z" fill={p.body} stroke={p.shade} strokeWidth="2" /><path d="M76 55 L77 41 L89 53Z M164 55 L163 41 L151 53Z" fill="#e9a8b5" /></>}
    {appearance.head === 'bunny-ears' && <><ellipse cx="90" cy="37" rx="13" ry="35" fill={p.body} stroke={p.shade} strokeWidth="2" transform="rotate(-12 90 37)" /><ellipse cx="150" cy="37" rx="13" ry="35" fill={p.body} stroke={p.shade} strokeWidth="2" transform="rotate(12 150 37)" /><ellipse cx="90" cy="37" rx="5" ry="24" fill="#e9a8b5" transform="rotate(-12 90 37)" /><ellipse cx="150" cy="37" rx="5" ry="24" fill="#e9a8b5" transform="rotate(12 150 37)" /></>}
    {appearance.head === 'horns' && <><path d="M76 66 Q55 48 70 29 Q91 46 93 58Z" fill="#f5d88d" stroke={p.accent} strokeWidth="2" /><path d="M164 66 Q185 48 170 29 Q149 46 147 58Z" fill="#f5d88d" stroke={p.accent} strokeWidth="2" /></>}
  </g>;
}

function FaceMarkings({ appearance }: { appearance: Appearance }) {
  return <g data-face={appearance.face} stroke="none">
    {appearance.face === 'blush' && <><ellipse cx="81" cy="138" rx="12" ry="6" fill="#e994a5" opacity=".38" /><ellipse cx="159" cy="138" rx="12" ry="6" fill="#e994a5" opacity=".38" /></>}
    {appearance.face === 'freckles' && <g fill="#9f6f73" opacity=".65"><circle cx="78" cy="137" r="2" /><circle cx="85" cy="140" r="1.6" /><circle cx="91" cy="137" r="1.5" /><circle cx="149" cy="137" r="1.5" /><circle cx="155" cy="140" r="1.6" /><circle cx="162" cy="137" r="2" /></g>}
    {appearance.face === 'stars' && <g fill="#f4cf68"><path d="M79 132 L82 138 L88 139 L83 143 L84 149 L79 146 L74 149 L75 143 L70 139 L76 138Z" /><path d="M161 132 L164 138 L170 139 L165 143 L166 149 L161 146 L156 149 L157 143 L152 139 L158 138Z" /></g>}
    {appearance.face === 'hearts' && <g fill="#df7f98" opacity=".8"><path d="M70 137 C70 130 80 130 81 136 C82 130 92 130 92 137 C92 143 81 149 81 149 C81 149 70 143 70 137Z" /><path d="M148 137 C148 130 158 130 159 136 C160 130 170 130 170 137 C170 143 159 149 159 149 C159 149 148 143 148 137Z" /></g>}
  </g>;
}

function Eyes({ appearance, mood }: { appearance: Appearance; mood: Mood }) {
  const p = PALETTES[appearance.palette];
  const color = { dark: '#443544', accent: p.accent, blue: '#477db3', green: '#477f68', warm: '#9c5b43' }[appearance.eyeColor];
  if (mood === 'done') return <g className="creature-eyes" data-eyes={appearance.eyes} stroke={color} fill="none" strokeWidth="4" strokeLinecap="round"><path d="M87 121 Q94 110 101 121" /><path d="M139 121 Q146 110 153 121" /></g>;
  if (appearance.eyes === 'sleepy') return <g className="creature-eyes" data-eyes="sleepy" stroke={color} fill="none" strokeWidth="4" strokeLinecap="round"><path d="M86 118 Q94 125 102 118" /><path d="M138 118 Q146 125 154 118" /></g>;
  if (appearance.eyes === 'happy') return <g className="creature-eyes" data-eyes="happy" stroke={color} fill="none" strokeWidth="4" strokeLinecap="round"><path d="M86 121 Q94 113 102 121" /><path d="M138 121 Q146 113 154 121" /></g>;
  if (appearance.eyes === 'sparkle') return <g className="creature-eyes" data-eyes="sparkle" fill={color}><path d="M94 107 L98 116 L107 120 L98 124 L94 133 L90 124 L81 120 L90 116Z" /><path d="M146 107 L150 116 L159 120 L150 124 L146 133 L142 124 L133 120 L142 116Z" /></g>;
  const round = appearance.eyes === 'round';
  return <g className="creature-eyes" data-eyes={appearance.eyes} fill={color}><ellipse cx="94" cy="120" rx={round ? 8 : 5} ry={round ? 8 : 8} /><ellipse cx="146" cy="120" rx={round ? 8 : 5} ry={round ? 8 : 8} /><circle cx="96" cy="117" r="1.7" fill="white" /><circle cx="148" cy="117" r="1.7" fill="white" /></g>;
}

function Mouth({ appearance, mood }: { appearance: Appearance; mood: Mood }) {
  const common = { fill: 'none', stroke: '#443544', strokeWidth: 3, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  if (mood === 'attention') return <ellipse cx="120" cy="143" rx="4" ry="5" {...common} />;
  if (mood === 'speaking') return <ellipse cx="120" cy="144" rx="5" ry="6" {...common} />;
  if (mood === 'thinking') return <path d="M115 143 L123 143" {...common} />;
  return <g data-mouth={appearance.mouth} {...common}>
    {appearance.mouth === 'smile' && <path d="M111 141 Q120 151 129 141" />}
    {appearance.mouth === 'tiny' && <path d="M117 144 Q120 147 123 144" />}
    {appearance.mouth === 'cat' && <path d="M120 143 Q115 138 111 143 Q115 149 120 144 Q125 149 129 143 Q125 138 120 143Z" />}
    {appearance.mouth === 'grin' && <path d="M108 140 Q120 154 132 140 Q120 147 108 140Z" fill="white" />}
  </g>;
}

function Eyewear({ appearance }: { appearance: Appearance }) {
  const p = PALETTES[appearance.palette];
  return <g data-eyewear={appearance.eyewear} fill="none" stroke={p.accent} strokeWidth="3">
    {appearance.eyewear === 'glasses' && <><rect x="77" y="107" width="34" height="28" rx="11" /><rect x="129" y="107" width="34" height="28" rx="11" /><path d="M111 118 Q120 113 129 118 M77 116 L65 112 M163 116 L175 112" /></>}
    {appearance.eyewear === 'round-glasses' && <><circle cx="94" cy="120" r="17" /><circle cx="146" cy="120" r="17" /><path d="M111 118 Q120 113 129 118 M77 116 L65 112 M163 116 L175 112" /></>}
    {appearance.eyewear === 'sunglasses' && <><path d="M76 108 L111 108 L108 130 Q94 141 80 129Z M129 108 L164 108 L160 129 Q146 141 132 130Z" fill="#443544" opacity=".88" /><path d="M111 116 L129 116 M76 112 L65 108 M164 112 L175 108" /></>}
    {appearance.eyewear === 'monocle' && <><circle cx="146" cy="120" r="18" /><path d="M164 128 Q170 149 162 166" /></>}
  </g>;
}

function OutfitRear({ appearance }: { appearance: Appearance }) {
  const p = PALETTES[appearance.palette];
  return <g data-outfit-rear={appearance.outfit}>
    {appearance.outfit === 'wizard' && <path d="M72 151 Q120 166 168 151 L198 215 Q120 231 42 215Z" fill={p.accent} stroke={p.shade} strokeWidth="2" />}
  </g>;
}

function OutfitBody({ appearance }: { appearance: Appearance }) {
  const p = PALETTES[appearance.palette];
  return <g data-outfit={appearance.outfit} strokeLinecap="round" strokeLinejoin="round">
    {appearance.outfit === 'work' && <><path d="M30 158 L90 153 Q120 167 150 153 L210 158 L210 205 L30 205Z" fill="#384454" /><path d="M100 156 Q120 163 140 156 L120 194Z" fill="#fff6e9" /><path d="M116 164 L124 164 L127 180 L120 189 L113 180Z" fill={p.accent} /><path d="M91 153 L109 160 L120 194 L91 177 L98 170 L85 163Z M149 153 L131 160 L120 194 L149 177 L142 170 L155 163Z" fill="#556578" /><rect x="151" y="174" width="22" height="12" rx="2" fill="#f4f1e9" /></>}
    {appearance.outfit === 'cozy' && <><path d="M43 158 Q76 151 94 155 Q120 168 146 155 Q164 151 197 158 L190 205 Q120 219 50 205Z" fill={p.accent} /><path d="M92 155 Q120 171 148 155 Q146 172 120 178 Q94 172 92 155Z" fill={p.shade} /><path d="M63 178 Q120 194 177 178 M58 193 Q120 209 182 193" fill="none" stroke={p.body} strokeWidth="3" strokeDasharray="5 5" /><path d="M113 184 C104 178 108 171 114 175 C120 169 126 175 120 182 C116 186 113 184 113 184Z" fill={p.light} /></>}
    {appearance.outfit === 'fitness' && <><path d="M48 158 Q72 152 91 154 L103 166 Q120 174 137 166 L149 154 Q168 152 192 158 L187 204 Q120 218 53 204Z" fill={p.accent} /><path d="M91 154 L103 166 Q120 174 137 166 L149 154" fill="none" stroke={p.light} strokeWidth="5" /><path d="M75 157 L83 194 M165 157 L157 194" stroke={p.light} strokeWidth="4" /><path d="M111 193 L119 177 L127 184 L120 184 L129 174" fill="none" stroke="#f7df89" strokeWidth="4" /></>}
    {appearance.outfit === 'rainy-day' && <><path d="M45 158 Q76 151 94 155 Q120 168 146 155 Q164 151 195 158 L190 205 Q120 219 50 205Z" fill="#e3b94d" /><path d="M94 155 Q120 174 146 155 L140 178 Q120 187 100 178Z" fill="#f4cf68" /><path d="M120 168 V207" stroke="#b77f2d" strokeWidth="3" /><circle cx="120" cy="183" r="2.5" fill="#fff0aa" /><circle cx="120" cy="195" r="2.5" fill="#fff0aa" /><path d="M65 190 Q120 203 175 190" fill="none" stroke="#fff0aa" strokeWidth="3" /></>}
    {appearance.outfit === 'explorer' && <><path d="M33 158 Q120 174 207 158 L212 208 H28Z" fill="#8e7957" /><path d="M87 154 L103 203 M153 154 L137 203" stroke="#5f513d" strokeWidth="8" /><rect x="103" y="180" width="34" height="22" rx="3" fill="#b9a174" /></>}
    {appearance.outfit === 'wizard' && <path d="M34 158 Q120 175 206 158 L212 208 H28Z" fill={p.accent} />}
    {appearance.outfit === 'artist' && <><path d="M48 158 Q76 151 94 155 Q120 169 146 155 Q164 151 192 158 L186 205 Q120 217 54 205Z" fill={p.body} /><path d="M92 155 Q120 174 148 155 L154 205 Q120 214 86 205Z" fill="#f0e5ce" stroke={p.accent} strokeWidth="2" /><path d="M103 184 Q120 190 137 184 V202 Q120 208 103 202Z" fill="none" stroke={p.accent} strokeWidth="3" /><circle cx="108" cy="174" r="3" fill="#d96b71" /><circle cx="120" cy="177" r="3" fill="#e3b94d" /><circle cx="132" cy="174" r="3" fill="#5e8fc2" /></>}
    {appearance.outfit === 'formal' && <><path d="M31 158 Q120 174 209 158 L213 208 H27Z" fill="#2f3340" /><path d="M88 155 L108 163 L120 198 L84 177Z M152 155 L132 163 L120 198 L156 177Z" fill="#4b5263" /><path d="M116 165 H124 L128 188 L120 198 L112 188Z" fill={p.accent} /><path d="M117 162 Q98 152 94 166 Q99 178 117 170Z M123 162 Q142 152 146 166 Q141 178 123 170Z" fill={p.accent} /><circle cx="120" cy="166" r="6" fill={p.light} /></>}
  </g>;
}

function OutfitAccessories({ appearance }: { appearance: Appearance }) {
  const p = PALETTES[appearance.palette];
  return <g data-outfit-accessories={appearance.outfit} strokeLinecap="round" strokeLinejoin="round">
    {appearance.outfit === 'fitness' && <><path d="M60 91 Q120 69 180 91 L178 101 Q120 82 62 101Z" fill={p.accent} /><path d="M66 92 Q120 76 174 92" fill="none" stroke={p.light} strokeWidth="2" /></>}
    {appearance.outfit === 'rainy-day' && <><path d="M73 78 Q83 49 120 47 Q157 49 167 78 Q154 68 145 65 Q120 57 95 65 Q86 68 73 78Z" fill="#e3b94d" stroke="#c99531" strokeWidth="2" /><path d="M78 77 Q120 61 162 77" fill="none" stroke="#fff0aa" strokeWidth="3" /></>}
    {appearance.outfit === 'explorer' && <><path d="M62 66 Q120 53 178 66 Q167 79 120 73 Q73 79 62 66Z" fill="#9d8051" /><path d="M82 62 Q90 35 120 39 Q150 35 158 62Z" fill="#b79a64" /></>}
    {appearance.outfit === 'wizard' && <><path d="M84 62 L126 6 L157 65Z" fill={p.accent} stroke={p.shade} strokeWidth="2" /><path d="M59 66 Q120 51 181 66 Q163 82 120 75 Q77 82 59 66Z" fill={p.shade} /><path d="M111 39 l3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z" fill="#f1d36b" /><path d="M160 204 L202 155" stroke="#443544" strokeWidth="5" /><path d="M204 144 L208 152 L217 155 L208 159 L204 168 L200 159 L191 155 L200 152Z" fill="#f1d36b" /></>}
  </g>;
}

export function Companion({ appearance, mood = 'idle', paused = false }: { appearance: Appearance; mood?: Mood; paused?: boolean }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const p = PALETTES[appearance.palette];
  return <svg className="companion" data-mood={mood} data-motion={appearance.motion} data-paused={paused} data-shape={appearance.shape} viewBox="0 0 240 240" role="img" aria-labelledby={`${id}-title`}>
    <title id={`${id}-title`}>{`${appearance.palette} ${appearance.shape} companion, ${mood}, ${appearance.eyes} eyes, ${appearance.face} face, ${appearance.outfit} outfit`}</title>
    <defs><radialGradient id={`${id}-body`} cx="35%" cy="23%" r="83%"><stop stopColor={p.light} /><stop offset=".62" stopColor={p.body} /><stop offset="1" stopColor={p.shade} /></radialGradient><clipPath id={`${id}-silhouette`}><path d={BODIES[appearance.shape]} /></clipPath></defs>
    <ellipse className="creature-shadow" cx="120" cy="207" rx="58" ry="9" fill={p.accent} opacity=".13" />
    <g className="creature-body">
      <ellipse cx="89" cy="187" rx="18" ry="10" fill={p.shade} /><ellipse cx="151" cy="187" rx="18" ry="10" fill={p.shade} />
      <OutfitRear appearance={appearance} />
      <Head appearance={appearance} />
      <path d={BODIES[appearance.shape]} fill={`url(#${id}-body)`} stroke={p.shade} strokeWidth="1.5" />
      <g data-outfit-clip={appearance.outfit} clipPath={`url(#${id}-silhouette)`}><OutfitBody appearance={appearance} /></g>
      <ellipse cx="69" cy="87" rx="12" ry="6" fill="white" opacity=".3" transform="rotate(-40 69 87)" />
      <g className="creature-arm"><ellipse cx="48" cy="147" rx="10" ry="19" fill={p.body} transform="rotate(25 48 147)" /></g><g className="creature-wave"><ellipse cx="192" cy="144" rx="10" ry="19" fill={p.body} transform="rotate(-30 192 144)" /></g>
      <OutfitAccessories appearance={appearance} />
      <g className="creature-face"><FaceMarkings appearance={appearance} /><Eyes appearance={appearance} mood={mood} /><Mouth appearance={appearance} mood={mood} /></g>
      <Eyewear appearance={appearance} />
    </g>
    {mood === 'thinking' && <g fill={p.accent} className="creature-thought"><circle cx="186" cy="67" r="3" /><circle cx="199" cy="52" r="5" /><circle cx="211" cy="32" r="7" /></g>}
    {mood === 'working' && <g className="creature-work" fill="none" stroke={p.accent} strokeWidth="3" strokeLinecap="round"><path d="M86 214 L154 214 M96 222 L144 222" /><circle cx="82" cy="215" r="3" fill={p.body} /></g>}
    {mood === 'attention' && <g stroke={p.accent} strokeWidth="4" strokeLinecap="round"><path d="M202 49 L202 62" /><circle cx="202" cy="72" r="2" fill={p.accent} /></g>}
    {mood === 'done' && <g className="creature-sparkle" fill={p.accent}><path d="M196 44 L199 53 L208 56 L199 59 L196 68 L193 59 L184 56 L193 53Z M40 65 L42 71 L48 73 L42 75 L40 81 L38 75 L32 73 L38 71Z" /></g>}
  </svg>;
}
