import { CircleAlert, CircleCheck, CircleDashed } from 'lucide-react'
import { laureateMarker } from '../lib/laureate.js'

const TONES = {
  pass: { icon: CircleCheck, classes: 'border-emerald-200 bg-emerald-50 text-emerald-800' },
  fail: { icon: CircleAlert, classes: 'border-cardinal/30 bg-cardinal/5 text-cardinal' },
  idle: { icon: CircleDashed, classes: 'border-gray-200 bg-gray-50 text-mit-gray' },
}

// Pass/fail marker for the prize-winner test, which re-runs after every data refresh.
export default function LaureateMarker({ data, onClick, compact = false }) {
  const marker = laureateMarker(data)
  const { icon: Icon, classes } = TONES[marker.tone]
  const Tag = onClick ? 'button' : 'span'
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      title={marker.detail}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${classes} ${onClick ? 'hover:underline' : ''}`}
    >
      <Icon className="h-3.5 w-3.5" />
      {compact ? marker.label.replace('Prize-winner test', 'Prize test') : marker.label}
    </Tag>
  )
}
