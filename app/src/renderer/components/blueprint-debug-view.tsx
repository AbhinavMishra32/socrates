import { useEffect, useMemo, useState } from "react";

import {
  fetchBlueprintBuildDetail,
  fetchBlueprintBuilds,
  openBlueprintBuildStream
} from "../lib/api";
import type {
  BlueprintBuild,
  BlueprintBuildDetailResponse,
  BlueprintBuildEventRecord,
  BlueprintBuildStage,
  BlueprintBuildSummary
} from "../types";

type BlueprintDebugViewProps = {
  debugMode: boolean;
  langSmithEnabled: boolean;
  langSmithProject: string | null;
  initialBuildId: string | null;
  onClose: () => void;
  onNavigateToBuild: (buildId: string | null) => void;
};

type ArtifactTab = "support" | "canonical" | "learner" | "hidden-tests";

const ARTIFACT_TABS: ArtifactTab[] = [
  "support",
  "canonical",
  "learner",
  "hidden-tests"
];

export function BlueprintDebugView({
  debugMode,
  langSmithEnabled,
  langSmithProject,
  initialBuildId,
  onClose,
  onNavigateToBuild
}: BlueprintDebugViewProps) {
  const [builds, setBuilds] = useState<BlueprintBuildSummary[]>([]);
  const [selectedBuildId, setSelectedBuildId] = useState<string | null>(initialBuildId);
  const [detail, setDetail] = useState<BlueprintBuildDetailResponse | null>(null);
  const [loadingBuilds, setLoadingBuilds] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState("");
  const [artifactTab, setArtifactTab] = useState<ArtifactTab>("learner");

  useEffect(() => {
    setSelectedBuildId(initialBuildId);
  }, [initialBuildId]);

  useEffect(() => {
    if (!debugMode) {
      return;
    }

    const controller = new AbortController();
    setLoadingBuilds(true);
    setError("");

    void fetchBlueprintBuilds(controller.signal)
      .then((response) => {
        setBuilds(response.builds);
        setSelectedBuildId((current) => current ?? response.builds[0]?.id ?? null);
      })
      .catch((loadError) => {
        if (controller.signal.aborted) {
          return;
        }

        setError(
          loadError instanceof Error
            ? loadError.message
            : "Failed to load blueprint builds."
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoadingBuilds(false);
        }
      });

    return () => {
      controller.abort();
    };
  }, [debugMode]);

  useEffect(() => {
    if (!debugMode || !selectedBuildId) {
      setDetail(null);
      return;
    }

    const controller = new AbortController();
    setLoadingDetail(true);

    void fetchBlueprintBuildDetail(selectedBuildId, controller.signal)
      .then((response) => {
        setDetail(response);
      })
      .catch((loadError) => {
        if (controller.signal.aborted) {
          return;
        }

        setError(
          loadError instanceof Error
            ? loadError.message
            : "Failed to load blueprint build detail."
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoadingDetail(false);
        }
      });

    return () => {
      controller.abort();
    };
  }, [debugMode, selectedBuildId]);

  useEffect(() => {
    if (!debugMode || !selectedBuildId) {
      return;
    }

    return openBlueprintBuildStream(selectedBuildId, {
      onDetail(nextDetail) {
        setDetail(nextDetail);
      },
      onStage(nextStage) {
        setDetail((current) => {
          if (!current) {
            return current;
          }

          const stages = upsertById(current.stages, nextStage);
          return {
            ...current,
            stages
          };
        });
      },
      onEvent(nextEvent) {
        setDetail((current) => {
          if (!current) {
            return current;
          }

          const events = upsertEvent(current.events, nextEvent);
          return {
            ...current,
            events
          };
        });

        setBuilds((current) =>
          current.map((build) =>
            build.id === nextEvent.buildId
              ? {
                  ...build,
                  lastEventAt: nextEvent.timestamp,
                  updatedAt: nextEvent.timestamp,
                  currentStage: nextEvent.stage,
                  currentStageTitle: nextEvent.title
                }
              : build
          )
        );
      },
      onState(nextBuild) {
        setDetail((current) =>
          current
            ? {
                ...current,
                build: nextBuild ?? null
              }
            : current
        );

        if (!nextBuild) {
          return;
        }

        setBuilds((current) => upsertById(current, toBuildSummary(nextBuild)));
      },
      onError(streamError) {
        setError(streamError.message);
      }
    });
  }, [debugMode, selectedBuildId]);

  const selectedBuild = detail?.build ?? null;
  const selectedArtifactFiles = useMemo(() => {
    if (!selectedBuild) {
      return [];
    }

    switch (artifactTab) {
      case "support":
        return selectedBuild.supportFiles;
      case "canonical":
        return selectedBuild.canonicalFiles;
      case "learner":
        return selectedBuild.learnerFiles;
      case "hidden-tests":
        return selectedBuild.hiddenTests;
      default:
        return [];
    }
  }, [artifactTab, selectedBuild]);

  if (!debugMode) {
    return (
      <section className="construct-debug-shell">
        <div className="construct-debug-empty">
          <h1>Blueprint debug mode is off</h1>
          <p>
            Set <code>CONSTRUCT_DEBUG_MODE=1</code> or raise <code>CONSTRUCT_DEBUG_LEVEL</code> to
            open the live blueprint inspector.
          </p>
          <button type="button" className="construct-debug-back" onClick={onClose}>
            Back to Construct
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="construct-debug-shell">
      <header className="construct-debug-header">
        <div>
          <span className="construct-debug-kicker">Observability</span>
          <h1>Blueprint builds</h1>
          <p>
            Inspect live project creation state, agent stages, streamed events, generated files,
            tests, and persisted plan snapshots.
          </p>
        </div>

        <div className="construct-debug-header-actions">
          <span className={`construct-debug-pill ${langSmithEnabled ? "is-active" : ""}`}>
            {langSmithEnabled
              ? `LangSmith: ${langSmithProject ?? "enabled"}`
              : "LangSmith disabled"}
          </span>
          <button type="button" className="construct-debug-back" onClick={onClose}>
            Back to workspace
          </button>
        </div>
      </header>

      {error ? <div className="construct-debug-error">{error}</div> : null}

      <div className="construct-debug-layout">
        <aside className="construct-debug-sidebar">
          <div className="construct-debug-sidebar-header">
            <strong>Builds</strong>
            <span>{loadingBuilds ? "Loading..." : `${builds.length} total`}</span>
          </div>

          <div className="construct-debug-build-list">
            {builds.map((build) => (
              <button
                key={build.id}
                type="button"
                className={`construct-debug-build-card ${
                  build.id === selectedBuildId ? "is-selected" : ""
                }`}
                onClick={() => {
                  setSelectedBuildId(build.id);
                  onNavigateToBuild(build.id);
                }}
              >
                <div className="construct-debug-build-card-header">
                  <strong>{build.goal}</strong>
                  <span className={`construct-debug-status is-${build.status}`}>
                    {build.status}
                  </span>
                </div>
                <p>{build.currentStageTitle ?? "Waiting for activity"}</p>
                <div className="construct-debug-build-card-meta">
                  <span>{build.detectedLanguage ?? "unknown language"}</span>
                  <span>{build.detectedDomain ?? "unknown domain"}</span>
                  <span>{formatTimestamp(build.updatedAt)}</span>
                </div>
              </button>
            ))}

            {!loadingBuilds && builds.length === 0 ? (
              <div className="construct-debug-sidebar-empty">
                No blueprint builds have been captured yet.
              </div>
            ) : null}
          </div>
        </aside>

        <main className="construct-debug-main">
          {!selectedBuildId ? (
            <div className="construct-debug-empty">
              <h2>Select a build</h2>
              <p>Choose a captured project creation run to inspect its live state and artifacts.</p>
            </div>
          ) : loadingDetail && !selectedBuild ? (
            <div className="construct-debug-empty">
              <h2>Loading build</h2>
              <p>Construct is loading the persisted build detail.</p>
            </div>
          ) : !selectedBuild ? (
            <div className="construct-debug-empty">
              <h2>Build unavailable</h2>
              <p>The selected build could not be found.</p>
            </div>
          ) : (
            <>
              <section className="construct-debug-summary-grid">
                <SummaryCard label="Status" value={selectedBuild.status} />
                <SummaryCard
                  label="Current stage"
                  value={selectedBuild.currentStageTitle ?? selectedBuild.currentStage ?? "n/a"}
                />
                <SummaryCard
                  label="Answers"
                  value={`${selectedBuild.answers.length} captured`}
                />
                <SummaryCard
                  label="Plan steps"
                  value={`${selectedBuild.plan?.steps.length ?? 0} planned`}
                />
              </section>

              <section className="construct-debug-section">
                <div className="construct-debug-section-header">
                  <div>
                    <span className="construct-debug-section-kicker">Build</span>
                    <h2>{selectedBuild.goal}</h2>
                  </div>
                  <div className="construct-debug-section-meta">
                    <span>{selectedBuild.detectedLanguage ?? "unknown language"}</span>
                    <span>{selectedBuild.detectedDomain ?? "unknown domain"}</span>
                    <span>{selectedBuild.learningStyle ?? "unknown style"}</span>
                  </div>
                </div>

                {selectedBuild.lastError ? (
                  <div className="construct-debug-inline-error">{selectedBuild.lastError}</div>
                ) : null}

                <div className="construct-debug-json-card">
                  <pre>{formatJson(selectedBuild.planningSession)}</pre>
                </div>
              </section>

              <section className="construct-debug-section">
                <div className="construct-debug-section-header">
                  <div>
                    <span className="construct-debug-section-kicker">Plan</span>
                    <h2>Personalized roadmap</h2>
                  </div>
                </div>

                {selectedBuild.plan ? (
                  <div className="construct-debug-plan-list">
                    {selectedBuild.plan.steps.map((step, index) => (
                      <article key={step.id} className="construct-debug-plan-step">
                        <div className="construct-debug-plan-step-header">
                          <strong>
                            {index + 1}. {step.title}
                          </strong>
                          <span>{step.kind}</span>
                        </div>
                        <p>{step.objective}</p>
                        <div className="construct-debug-token-row">
                          {step.concepts.map((concept) => (
                            <span key={concept} className="construct-debug-token">
                              {concept}
                            </span>
                          ))}
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <div className="construct-debug-inline-note">
                    The plan has not been persisted yet.
                  </div>
                )}
              </section>

              <section className="construct-debug-section">
                <div className="construct-debug-section-header">
                  <div>
                    <span className="construct-debug-section-kicker">Stages</span>
                    <h2>Persistent stage snapshots</h2>
                  </div>
                </div>

                <div className="construct-debug-stage-list">
                  {detail?.stages.map((stage) => (
                    <details key={stage.id} className="construct-debug-stage-card">
                      <summary>
                        <div>
                          <strong>{stage.title}</strong>
                          <span>{stage.stage}</span>
                        </div>
                        <span className={`construct-debug-status is-${stage.status}`}>
                          {stage.status}
                        </span>
                      </summary>
                      <p>{stage.detail}</p>
                      <div className="construct-debug-stage-metadata">
                        <span>Started {formatTimestamp(stage.startedAt)}</span>
                        <span>Updated {formatTimestamp(stage.updatedAt)}</span>
                      </div>
                      <div className="construct-debug-stage-columns">
                        <DebugJsonCard title="Input" value={stage.inputJson} />
                        <DebugJsonCard title="Output" value={stage.outputJson} />
                        <DebugJsonCard title="Metadata" value={stage.metadataJson} />
                      </div>
                    </details>
                  ))}
                </div>
              </section>

              <section className="construct-debug-section">
                <div className="construct-debug-section-header">
                  <div>
                    <span className="construct-debug-section-kicker">Artifacts</span>
                    <h2>Generated files and hidden tests</h2>
                  </div>
                </div>

                <div className="construct-debug-tab-row">
                  {ARTIFACT_TABS.map((tab) => (
                    <button
                      key={tab}
                      type="button"
                      className={`construct-debug-tab ${artifactTab === tab ? "is-selected" : ""}`}
                      onClick={() => {
                        setArtifactTab(tab);
                      }}
                    >
                      {tab}
                    </button>
                  ))}
                </div>

                <div className="construct-debug-artifact-list">
                  {selectedArtifactFiles.map((file) => (
                    <details key={`${file.group}:${file.path}`} className="construct-debug-file-card">
                      <summary>
                        <strong>{file.path}</strong>
                        <span>{file.group}</span>
                      </summary>
                      <pre>{file.content}</pre>
                    </details>
                  ))}

                  {selectedArtifactFiles.length === 0 ? (
                    <div className="construct-debug-inline-note">
                      No files have been captured for this artifact group yet.
                    </div>
                  ) : null}
                </div>
              </section>

              <section className="construct-debug-section">
                <div className="construct-debug-section-header">
                  <div>
                    <span className="construct-debug-section-kicker">Events</span>
                    <h2>Live agent event log</h2>
                  </div>
                </div>

                <div className="construct-debug-event-list">
                  {detail?.events
                    .slice()
                    .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
                    .map((event) => (
                      <details key={event.id} className="construct-debug-event-card">
                        <summary>
                          <div>
                            <strong>{event.title}</strong>
                            <span>{event.stage}</span>
                          </div>
                          <span className={`construct-debug-status is-${event.level}`}>
                            {event.level}
                          </span>
                        </summary>
                        <p>{event.detail}</p>
                        <div className="construct-debug-stage-metadata">
                          <span>{formatTimestamp(event.timestamp)}</span>
                          {event.jobId ? <span>Job {event.jobId}</span> : null}
                        </div>
                        <DebugJsonCard title="Payload" value={event.payload} />
                      </details>
                    ))}
                </div>
              </section>
            </>
          )}
        </main>
      </div>
    </section>
  );
}

function SummaryCard({
  label,
  value
}: {
  label: string;
  value: string;
}) {
  return (
    <article className="construct-debug-summary-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function DebugJsonCard({
  title,
  value
}: {
  title: string;
  value: unknown;
}) {
  return (
    <article className="construct-debug-json-card">
      <h3>{title}</h3>
      <pre>{formatJson(value)}</pre>
    </article>
  );
}

function formatJson(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatTimestamp(value: string): string {
  const timestamp = Date.parse(value);

  if (Number.isNaN(timestamp)) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(timestamp);
}

function upsertById<T extends { id: string }>(items: T[], nextItem: T): T[] {
  const remaining = items.filter((item) => item.id !== nextItem.id);
  return [nextItem, ...remaining];
}

function upsertEvent(
  items: BlueprintBuildEventRecord[],
  nextItem: BlueprintBuildEventRecord
): BlueprintBuildEventRecord[] {
  const remaining = items.filter((item) => item.id !== nextItem.id);
  return [...remaining, nextItem].sort((left, right) =>
    left.timestamp.localeCompare(right.timestamp)
  );
}

function toBuildSummary(build: BlueprintBuild): BlueprintBuildSummary {
  return {
    id: build.id,
    sessionId: build.sessionId,
    userId: build.userId,
    goal: build.goal,
    learningStyle: build.learningStyle,
    detectedLanguage: build.detectedLanguage,
    detectedDomain: build.detectedDomain,
    status: build.status,
    currentStage: build.currentStage,
    currentStageTitle: build.currentStageTitle,
    currentStageStatus: build.currentStageStatus,
    lastError: build.lastError,
    langSmithProject: build.langSmithProject,
    traceUrl: build.traceUrl,
    createdAt: build.createdAt,
    updatedAt: build.updatedAt,
    completedAt: build.completedAt,
    lastEventAt: build.lastEventAt
  };
}
