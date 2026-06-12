interface StubTabProps {
  title: string;
  message?: string;
  illustrative?: boolean;
}

export function StubTab({ title, message, illustrative }: StubTabProps) {
  return (
    <div>
      <h1 className="section-title">{title}</h1>
      <p className="section-subtitle">
        {message ?? "Coming in the next iteration. The math layer is ready; UI build in progress."}
      </p>
      {illustrative && (
        <div className="banner-illustrative">
          <span className="banner-illustrative-icon" aria-hidden>⚠</span>
          <span>
            <strong>Illustrative only.</strong> The Model Sense canonical deposit decay framework lands
            in Chapter 4+ work; this tab will host a simple logistic spread-driven decay for engine
            demonstration once the UI is built out.
          </span>
        </div>
      )}
    </div>
  );
}
