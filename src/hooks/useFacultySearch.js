import { useEffect, useState } from 'react'

// Stub: loads the faculty index. The UI thread adds FlexSearch + filtering.
export default function useFacultySearch() {
  const [faculty, setFaculty] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}data/faculty_index.json`)
      .then((res) => res.json())
      .then(setFaculty)
      .catch(() => setFaculty([]))
      .finally(() => setLoading(false))
  }, [])

  return { faculty, loading }
}
