// Stub: the UI thread replaces this with the full detail modal.
export default function FacultyDetailModal({ faculty, onClose }) {
  if (!faculty) return null
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-lg" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-xl font-semibold tracking-tight text-charcoal">{faculty.name}</h2>
        <p className="text-sm text-mit-gray">{faculty.title}</p>
      </div>
    </div>
  )
}
