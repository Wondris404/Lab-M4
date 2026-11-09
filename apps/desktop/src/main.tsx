import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AppSettingsModal, useAppSettings } from "./settings";

function Root() {
  const appSettings = useAppSettings();
  return (
    <>
      <App appSettings={appSettings} />
      {appSettings.ready && appSettings.settingsOpen && <AppSettingsModal api={appSettings} />}
    </>
  );
}
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<React.StrictMode><Root /></React.StrictMode>);
