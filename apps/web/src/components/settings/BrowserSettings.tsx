import { useCallback, useEffect, useMemo, useState } from "react";
import type { DesktopCookieImportSources } from "@t3tools/contracts";

import { desktopErrorMessage } from "../preview/desktopErrorTag";
import { previewBridge } from "../preview/previewBridge";
import { useProjects } from "~/state/entities";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { describeImportResult, toChoices } from "./BrowserSettings.logic";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function BrowserSettingsPanel() {
  const bridge = previewBridge;
  const projects = useProjects();
  const environmentIds = useMemo(
    () => [...new Set(projects.map((project) => project.environmentId))],
    [projects],
  );

  const [sources, setSources] = useState<DesktopCookieImportSources | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [status, setStatus] = useState<{ tone: "info" | "error"; message: string } | null>(null);

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    void bridge.cookieImport
      .listSources()
      .then((result) => {
        if (cancelled) return;
        setSources(result);
        setSelected(toChoices(result.sources)[0]?.value ?? null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setSources({ supported: true, sources: [] });
        setStatus({
          tone: "error",
          message: desktopErrorMessage(error, "Could not list installed browsers."),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  const choices = useMemo(() => toChoices(sources?.sources ?? []), [sources]);
  const activeChoice = choices.find((choice) => choice.value === selected) ?? null;

  const handleImport = useCallback(async () => {
    if (!bridge || activeChoice === null) return;
    setIsImporting(true);
    setStatus(null);
    try {
      const result = await bridge.cookieImport.run({
        browserId: activeChoice.browserId,
        profileDirectory: activeChoice.profileDirectory,
        environmentIds,
      });
      setStatus({ tone: "info", message: describeImportResult(result) });
    } catch (error: unknown) {
      setStatus({
        tone: "error",
        message: desktopErrorMessage(error, "The import failed."),
      });
    } finally {
      setIsImporting(false);
    }
  }, [activeChoice, bridge, environmentIds]);

  const handleClear = useCallback(async () => {
    if (!bridge) return;
    setStatus(null);
    try {
      await bridge.clearCookies();
      setStatus({ tone: "info", message: "Preview browser data cleared." });
    } catch (error: unknown) {
      setStatus({
        tone: "error",
        message: desktopErrorMessage(error, "Could not clear the preview browser."),
      });
    }
  }, [bridge]);

  const importDescription = !bridge
    ? "Cookie import is only available in the T3 Code desktop app."
    : sources !== null && !sources.supported
      ? "Cookie import is not supported on this platform yet."
      : choices.length === 0 && sources !== null
        ? "No supported browsers with a readable profile were found."
        : "Copy your signed-in sessions from an installed browser so previews can open pages that need a login. " +
          "You'll be asked to confirm, and your other browser is never modified.";

  return (
    <SettingsPageContainer>
      <SettingsSection title="Preview browser">
        <SettingsRow
          {...searchableSetting("import-browser-cookies")}
          description={importDescription}
          status={
            status === null ? null : (
              <span className={status.tone === "error" ? "text-destructive" : undefined}>
                {status.message}
              </span>
            )
          }
          control={
            <div className="flex w-full items-center gap-2 sm:w-auto">
              <Select
                value={selected ?? ""}
                onValueChange={(value) => setSelected(String(value))}
                disabled={choices.length === 0 || isImporting}
              >
                <SelectTrigger className="w-full sm:w-56" aria-label="Browser to import from">
                  <SelectValue>{activeChoice?.label ?? "No browsers found"}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {choices.map((choice) => (
                    <SelectItem key={choice.value} hideIndicator value={choice.value}>
                      {choice.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <Button
                onClick={() => void handleImport()}
                disabled={activeChoice === null || isImporting}
              >
                {isImporting ? <Spinner /> : null}
                Import
              </Button>
            </div>
          }
        />
        <SettingsRow
          {...searchableSetting("clear-browser-cookies")}
          description="Removes every cookie and all site data from the preview browser, including anything imported. Sites will ask you to sign in again."
          control={
            <Button variant="outline" onClick={() => void handleClear()} disabled={!bridge}>
              Clear data
            </Button>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
