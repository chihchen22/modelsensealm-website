/**
 * Placeholder tab for Phase-2+ surfaces. Lets the section nav structure
 * land in Phase 1 without forcing every tab to be implemented up-front.
 */

interface ComingSoonTabProps {
  title: string;
  phase: string;
  description: string;
}

export function ComingSoonTab({ title, phase, description }: ComingSoonTabProps) {
  return (
    <div>
      <h1 className="section-title">{title}</h1>
      <p className="section-subtitle">{description}</p>
      <div className="dash-card" style={{ marginTop: 24 }}>
        <div className="group-label">Status</div>
        <p style={{ fontSize: 13, lineHeight: 1.6, marginTop: 8 }}>
          Scheduled for <strong>{phase}</strong> of the ALM Model Lab build. Section nav and the
          underlying instrument / analytics interfaces are in place; concrete UI lands when its
          phase ships.
        </p>
      </div>
    </div>
  );
}
