import { useTranslation } from "react-i18next";
import { Icon, type IconName } from "./Icon.js";

export function PageState({
  title,
  description,
  icon = "spark",
  action,
}: {
  title: string;
  description?: string;
  icon?: IconName;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="page-state">
      <span className="page-state-icon">
        <Icon name={icon} size={26} />
      </span>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action && (
        <button type="button" className="primary-button" onClick={action.onClick}>
          {action.label}
          <Icon name="arrow" size={16} />
        </button>
      )}
    </div>
  );
}

export function LoadingState() {
  const { t } = useTranslation();
  return (
    <div className="loading-state" role="status">
      <span className="loading-spinner" aria-hidden="true" />
      {t("ui.loading")}
    </div>
  );
}
