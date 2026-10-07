import { Check, ChevronDown, RotateCcw } from 'lucide-react'
import { countryName } from '../lib/format.js'

function Select({ id, label, value, onChange, children, disabled }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-xs font-semibold uppercase tracking-wide text-mit-gray">
        {label}
      </label>
      <div className="relative">
        <select
          id={id}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className="w-full appearance-none rounded-xl border border-gray-200 bg-white py-2.5 pl-3 pr-9 text-sm text-charcoal transition focus:border-cardinal/50 focus:outline-none focus:ring-2 focus:ring-cardinal/15 disabled:bg-gray-50 disabled:text-mit-gray"
        >
          {children}
        </select>
        <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-mit-gray" />
      </div>
    </div>
  )
}

/**
 * Cascading filters: picking a country narrows the institution list, and
 * domain tags are a multi-select (a faculty member matches if they work in any
 * of the selected domains).
 */
export default function FilterSidebar({ options, filters, setFilters, resetFilters, activeFilterCount, className = '' }) {
  const setCountry = (country) =>
    setFilters((f) => {
      const keepInstitution = options.institutionsAll?.some(
        (i) => i.name === f.institution && (!country || i.country_code === country),
      )
      return { ...f, country, institution: keepInstitution ? f.institution : '' }
    })
  const setInstitution = (institution) => setFilters((f) => ({ ...f, institution }))
  const toggleDomain = (d) =>
    setFilters((f) => ({
      ...f,
      domains: f.domains.includes(d) ? f.domains.filter((x) => x !== d) : [...f.domains, d],
    }))

  return (
    <aside className={`space-y-6 rounded-2xl border border-gray-100 bg-white p-5 shadow-sm ${className}`}>
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold tracking-tight text-charcoal">Filters</h2>
        {activeFilterCount > 0 && (
          <button
            type="button"
            onClick={resetFilters}
            className="flex items-center gap-1 text-xs font-medium text-mit-gray transition hover:text-cardinal"
          >
            <RotateCcw className="h-3.5 w-3.5" /> Clear all
          </button>
        )}
      </div>

      <Select id="filter-country" label="Country" value={filters.country} onChange={setCountry}>
        <option value="">All countries</option>
        {options.countries.map((c) => (
          <option key={c.code} value={c.code}>
            {countryName(c.code)} ({c.count})
          </option>
        ))}
      </Select>

      <Select
        id="filter-institution"
        label="Institution"
        value={filters.institution}
        onChange={setInstitution}
        disabled={options.institutions.length === 0}
      >
        <option value="">{filters.country ? `All in ${countryName(filters.country)}` : 'All institutions'}</option>
        {options.institutions.map((i) => (
          <option key={i.name} value={i.name}>
            {i.rank != null ? `#${i.rank} ` : ''}
            {i.name} ({i.count})
          </option>
        ))}
      </Select>

      <fieldset className="space-y-2">
        <legend className="text-xs font-semibold uppercase tracking-wide text-mit-gray">Research domains</legend>
        <div className="flex flex-wrap gap-2 pt-1.5">
          {options.domains.map(({ name, count }) => {
            const active = filters.domains.includes(name)
            return (
              <button
                key={name}
                type="button"
                aria-pressed={active}
                onClick={() => toggleDomain(name)}
                className={`flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium transition ${
                  active
                    ? 'border-cardinal bg-cardinal text-white'
                    : 'border-gray-200 text-gray-700 hover:border-cardinal/40 hover:text-cardinal'
                }`}
              >
                {active && <Check className="h-3 w-3" />}
                {name}
                <span className={active ? 'text-white/70' : 'text-mit-gray'}>{count}</span>
              </button>
            )
          })}
        </div>
      </fieldset>
    </aside>
  )
}
