import { openUrl } from "@tauri-apps/plugin-opener";
import desktopPackage from "../../package.json";

const WRAITH_REPO_URL = "https://github.com/Wondris404/Wraith";
const WRAITH_LICENSE_URL =
  "https://github.com/Wondris404/Wraith/blob/700f170bcea84b78c1a1fc455f349f49868b5e0d/LICENSE";

function openExternal(url: string) {
  void openUrl(url).catch(() => undefined);
}

export function AboutPanel() {
  return (
    <section className="settings-section about-panel" aria-label="About Lab-M4">
      <h2 className="about-name">Lab-M4</h2>
      <p className="settings-section-hint">Version {desktopPackage.version}</p>
      <p className="about-attribution">Based on Wraith</p>
      <p className="about-links">
        <a
          href={WRAITH_REPO_URL}
          onClick={(event) => {
            event.preventDefault();
            openExternal(WRAITH_REPO_URL);
          }}
        >
          Wraith repository
        </a>
        <a
          href={WRAITH_LICENSE_URL}
          onClick={(event) => {
            event.preventDefault();
            openExternal(WRAITH_LICENSE_URL);
          }}
        >
          Wraith license
        </a>
      </p>
    </section>
  );
}
