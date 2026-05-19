export default function Loading() {
  return (
    <div>
      <div className="page-header">
        <div className="skel" style={{ height: 10, width: 140, marginBottom: 12 }} />
        <div className="skel" style={{ height: 36, width: 280, marginBottom: 12 }} />
        <div className="skel" style={{ height: 14, width: 420 }} />
      </div>
      <div className="metrics-row" style={{ marginTop: 24 }}>
        {[...Array(3)].map((_, i) => <div key={i} className="skel" style={{ height: 64 }} />)}
      </div>
      <div style={{ marginTop: 32 }}>
        {[...Array(15)].map((_, i) => <div key={i} className="skel" style={{ height: 44, marginBottom: 2 }} />)}
      </div>
    </div>
  )
}
