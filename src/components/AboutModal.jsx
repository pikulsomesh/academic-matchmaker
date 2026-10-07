import { CodeXml, Globe, TriangleAlert, UserRound } from 'lucide-react'
import Modal from './Modal.jsx'

const LINKS = [
  { label: 'Website', icon: Globe, href: 'https://someshmohapatra.in/' },
  { label: 'LinkedIn', icon: UserRound, href: 'https://www.linkedin.com/in/pikulsomesh/' },
  { label: 'GitHub', icon: CodeXml, href: 'https://github.com/pikulsomesh/' },
]

const displayUrl = (href) => href.replace(/^https:\/\/(www\.)?/, '').replace(/\/$/, '')

export default function AboutModal({ open, onClose }) {
  return (
    <Modal open={open} onClose={onClose} labelledBy="about-title" maxWidth="max-w-xl">
      <div className="space-y-6 p-6 sm:p-8">
        <div>
          <h2 id="about-title" className="text-2xl font-semibold tracking-tight text-charcoal">
            About this project
          </h2>
          <p className="mt-2 leading-relaxed">
            Global Academic Matchmaker helps prospective PhD and post-doc candidates discover faculty across the top
            100 global universities by research alignment. Matching runs entirely in your browser, so uploaded resumes
            and profiles never leave your device.
          </p>
        </div>

        <div
          role="note"
          className="flex gap-3 rounded-xl border border-cardinal/20 bg-cardinal/5 p-4 text-sm leading-relaxed text-charcoal"
        >
          <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-cardinal" />
          <p>
            <strong className="font-semibold text-cardinal">Disclaimer:</strong> This application is a personal,
            independent open-source project. It is in no way affiliated with, endorsed by, sponsored by, or officially
            connected to the Massachusetts Institute of Technology (MIT) or any other academic institution listed
            herein.
          </p>
        </div>

        <div className="border-t border-gray-100 pt-6">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-mit-gray">Author</h3>
          <p className="mt-2 leading-relaxed">
            Created by Somesh Mohapatra (PhD in AI for Materials, MBA from MIT Sloan School of Management, Director of
            Analytics at Caterpillar Inc., BTech from IIT Roorkee; holds CMA, CFA, and CSCP credentials).
          </p>
          <ul className="mt-4 space-y-2 text-sm">
            {LINKS.map(({ label, icon: Icon, href }) => (
              <li key={label} className="flex items-center gap-2">
                <Icon className="h-4 w-4 text-mit-gray" />
                <span className="font-medium text-charcoal">{label}:</span>
                <a href={href} target="_blank" rel="noreferrer" className="text-cardinal hover:underline">
                  {displayUrl(href)}
                </a>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Modal>
  )
}
