import { useState } from 'react'
import { Check, Link2 } from 'lucide-react'

// Copies this page's address, which carries the search and the open researcher (lib/urlState.js).
export default function CopyLinkButton({ label = 'Copy link', className = '' }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      window.prompt('Copy this link', window.location.href)
    }
  }
  return (
    <button
      type="button"
      onClick={copy}
      className={`flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-medium text-mit-gray transition hover:bg-gray-50 hover:text-charcoal ${className}`}
    >
      {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Link2 className="h-4 w-4" />}
      {copied ? 'Link copied' : label}
    </button>
  )
}
