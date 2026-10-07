// Stub: the UI thread adds the author bio and disclaimer text from the blueprint.
export default function AboutModal({ open, onClose }) {
  if (!open) return null
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-lg" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-xl font-semibold tracking-tight text-charcoal">About</h2>
      </div>
    </div>
  )
}
