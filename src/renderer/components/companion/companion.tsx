import { useId } from 'react';

export const PALETTES = {
  lavender: { light: '#f3eaff', body: '#c3a4e5', shade: '#9975bb', accent: '#76518f' },
  peach: { light: '#fff1db', body: '#f2bb9d', shade: '#d68b7d', accent: '#a75f61' },
  mint: { light: '#edfae8', body: '#a8d5c1', shade: '#73aa9e', accent: '#437e79' },
  sky: { light: '#eaf6ff', body: '#a6c9e7', shade: '#759cce', accent: '#516fa5' },
};
export type Mood = 'idle' | 'thinking' | 'working' | 'attention' | 'done' | 'speaking';
import type { Appearance } from '@shared/appearance';
export { INITIAL_APPEARANCE, type Appearance } from '@shared/appearance';
const BODIES = {
  pebble: 'M49 130 C43 79 70 47 120 47 C170 47 197 79 191 130 C187 172 161 190 120 190 C79 190 53 172 49 130Z',
  mochi: 'M39 139 C40 105 65 67 120 67 C175 67 200 105 201 139 C204 176 166 190 120 190 C74 190 36 176 39 139Z',
  puff: 'M46 137 C27 116 39 82 61 77 C64 47 99 35 120 51 C145 35 177 49 180 77 C207 86 208 115 194 137 C201 171 164 196 120 187 C78 199 40 174 46 137Z',
};
export function Companion({ appearance, mood = 'idle', paused = false }: { appearance: Appearance; mood?: Mood; paused?: boolean }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const p = PALETTES[appearance.palette];
  return <svg className="companion" data-mood={mood} data-motion={appearance.motion} data-paused={paused} viewBox="0 0 240 240" role="img" aria-labelledby={`${id}-title`}>
    <title id={`${id}-title`}>{`${appearance.palette} ${appearance.shape} companion, ${mood}, outfit: ${appearance.outfit}`}</title>
    <defs><radialGradient id={`${id}-body`} cx="35%" cy="23%" r="83%"><stop stopColor={p.light} /><stop offset=".62" stopColor={p.body} /><stop offset="1" stopColor={p.shade} /></radialGradient><clipPath id={`${id}-silhouette`}><path d={BODIES[appearance.shape]} /></clipPath></defs>
    <ellipse className="creature-shadow" cx="120" cy="207" rx="58" ry="9" fill={p.accent} opacity=".13" />
    <g className="creature-body">
      <ellipse cx="89" cy="187" rx="18" ry="10" fill={p.shade} /><ellipse cx="151" cy="187" rx="18" ry="10" fill={p.shade} />
      <path d={BODIES[appearance.shape]} fill={`url(#${id}-body)`} stroke={p.shade} strokeWidth="1.5" />
      {/* Clothes follow the body animation and are clipped to each silhouette. */}
      <g clipPath={`url(#${id}-silhouette)`} data-outfit={appearance.outfit}>
        {appearance.outfit === 'suit' && <>
          <path d="M30 158 L90 153 Q120 167 150 153 L210 158 L210 205 L30 205Z" fill="#384454" />
          <path d="M100 156 Q120 163 140 156 L120 194Z" fill="#fff6e9" />
          <path d="M116 164 L124 164 L127 180 L120 189 L113 180Z" fill={p.accent} />
          <path d="M91 153 L109 160 L120 194 L91 177 L98 170 L85 163Z M149 153 L131 160 L120 194 L149 177 L142 170 L155 163Z" fill="#556578" />
          <path d="M157 174 L174 174" stroke="#c8d6e6" strokeWidth="3" strokeLinecap="round" />
          <circle cx="120" cy="195" r="2" fill="#d8c8a0" />
        </>}
        {appearance.outfit === 'fitness' && <>
          <path d="M30 159 L90 153 Q120 174 150 153 L210 159 L210 206 L30 206Z" fill={p.accent} />
          <path d="M90 155 Q120 174 150 155" fill="none" stroke={p.light} strokeWidth="5" />
          <path d="M64 161 L76 190 M176 161 L164 190" stroke={p.light} strokeWidth="5" />
          <path d="M146 173 L158 173 L153 179 L162 179 L149 190 L152 182 L144 182Z" fill="#f7df89" />
          <path d="M27 86 Q120 63 213 86 L213 99 Q120 78 27 99Z" fill={p.accent} />
          <path d="M30 91 Q120 69 210 91" fill="none" stroke={p.light} strokeWidth="3" />
        </>}
        {appearance.outfit === 'sweater' && <>
          <path d="M28 161 L91 153 Q120 165 149 153 L212 161 L212 208 L28 208Z" fill={p.accent} />
          <path d="M89 156 Q120 174 151 156" fill="none" stroke={p.light} strokeWidth="8" />
          <path d="M63 174 L72 180 L81 174 L90 180 M150 180 L159 174 L168 180 L177 174" fill="none" stroke={p.body} strokeWidth="3" strokeLinecap="round" />
          <path d="M120 188 C102 179 111 169 120 177 C129 169 138 179 120 188Z" fill={p.light} />
          <path d="M63 190 L177 190" stroke={p.body} strokeWidth="4" strokeDasharray="3 4" />
        </>}
      </g>
      <ellipse cx="69" cy="87" rx="12" ry="6" fill="white" opacity=".3" transform="rotate(-40 69 87)" />
      <g className="creature-arm"><ellipse cx="48" cy="147" rx="10" ry="19" fill={p.body} transform="rotate(25 48 147)" /></g>
      <g className="creature-wave"><ellipse cx="192" cy="144" rx="10" ry="19" fill={p.body} transform="rotate(-30 192 144)" /></g>
      <g className="creature-face" fill="none" stroke="#443544" strokeWidth="4" strokeLinecap="round">
        <ellipse cx="81" cy="138" rx="12" ry="6" fill="#e994a5" opacity=".38" stroke="none" /><ellipse cx="159" cy="138" rx="12" ry="6" fill="#e994a5" opacity=".38" stroke="none" />
        <g className="creature-eyes">
          {mood === 'done' ? <><path d="M87 121 Q94 110 101 121" /><path d="M139 121 Q146 110 153 121" /></> : appearance.face === 'sleepy' ? <><path d="M86 118 Q94 125 102 118" /><path d="M138 118 Q146 125 154 118" /></> : <><ellipse cx="94" cy="120" rx="5" ry="8" fill="#443544" stroke="none" /><ellipse cx="146" cy="120" rx="5" ry="8" fill="#443544" stroke="none" /><circle cx="95" cy="117" r="1.5" fill="white" stroke="none" /><circle cx="147" cy="117" r="1.5" fill="white" stroke="none" /></>}
        </g>
        {mood === 'attention' ? <ellipse cx="120" cy="143" rx="4" ry="5" strokeWidth="3" /> : mood === 'speaking' ? <ellipse cx="120" cy="144" rx="5" ry="6" strokeWidth="3" /> : mood === 'thinking' ? <path d="M115 143 L123 143" strokeWidth="3" /> : <path d="M111 141 Q120 151 129 141" strokeWidth="3" />}
      </g>
      {appearance.accessory === 'glasses' && <g fill="none" stroke={p.accent} strokeWidth="3"><rect x="77" y="107" width="34" height="28" rx="11" /><rect x="129" y="107" width="34" height="28" rx="11" /><path d="M111 118 Q120 113 129 118 M77 116 L65 112 M163 116 L175 112" /></g>}
      {appearance.accessory === 'scarf' && <g fill={p.accent}><path d="M64 164 Q120 186 176 164 L172 177 Q120 198 68 177Z" /><path d="M146 178 L167 175 L174 205 Q162 211 151 203Z" /><path d="M156 190 L169 187" stroke={p.light} strokeWidth="3" /></g>}
      {appearance.accessory === 'sprout' && <g stroke="#56826b" strokeWidth="3" strokeLinecap="round"><path d="M120 57 Q119 41 128 29" fill="none" /><path d="M122 43 Q95 44 99 26 Q119 24 122 43" fill="#a0c890" /><path d="M124 37 Q124 15 144 18 Q147 36 124 37" fill="#bcd99b" /></g>}
    </g>
    {mood === 'thinking' && <g fill={p.accent} className="creature-thought"><circle cx="186" cy="67" r="3" /><circle cx="199" cy="52" r="5" /><circle cx="211" cy="32" r="7" /></g>}
    {mood === 'working' && <g className="creature-work" fill="none" stroke={p.accent} strokeWidth="3" strokeLinecap="round"><path d="M86 214 L154 214 M96 222 L144 222" /><circle cx="82" cy="215" r="3" fill={p.body} /></g>}
    {mood === 'attention' && <g stroke={p.accent} strokeWidth="4" strokeLinecap="round"><path d="M202 49 L202 62" /><circle cx="202" cy="72" r="2" fill={p.accent} /></g>}
    {mood === 'done' && <g className="creature-sparkle" fill={p.accent}><path d="M196 44 L199 53 L208 56 L199 59 L196 68 L193 59 L184 56 L193 53Z M40 65 L42 71 L48 73 L42 75 L40 81 L38 75 L32 73 L38 71Z" /></g>}
  </svg>;
}
