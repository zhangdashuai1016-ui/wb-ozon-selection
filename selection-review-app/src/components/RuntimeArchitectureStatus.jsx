import { runtimeArchitectureView } from "../runtimeArchitectureView";

export default function RuntimeArchitectureStatus({ status }) {
  const view = runtimeArchitectureView(status);
  return (
    <span
      className={`runtime-architecture-status ${view.code}`}
      data-testid="runtime-architecture-status"
      title={view.detail}
    >
      <i aria-hidden="true" />{view.label}
    </span>
  );
}
