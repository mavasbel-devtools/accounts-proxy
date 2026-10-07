// Port of opencode-antigravity-auth @ 5c6f7c2 domain/services/ProjectResolver.ts#extractProjectIds (blob 65f425e9).
/** Usable project ids of a `loadCodeAssist` response; anything unrecognizable yields [] (the caller then onboards). */
export function extractProjectIds(raw: Readonly<Record<string, unknown>>): string[] {
  const ids: string[] = [];
  const direct = raw["projectId"];
  if (typeof direct === "string" && direct.length > 0) ids.push(direct);
  const companion = raw["cloudaicompanionProject"];
  if (typeof companion === "string" && companion.length > 0) ids.push(companion);
  for (const key of ["allowedProjects", "projects"]) {
    const list = raw[key];
    if (!Array.isArray(list)) continue;
    for (const p of list) {
      if (typeof p === "string" && p.length > 0) ids.push(p);
      else if (p !== null && typeof p === "object") {
        const id = (p as Record<string, unknown>)["id"];
        if (typeof id === "string" && id.length > 0) ids.push(id);
      }
    }
  }
  return [...new Set(ids)];
}

/** Source AntigravityApiClientAdapter.onboardUser: `response.cloudaicompanionProject.id`, else "". */
export function onboardedProjectId(raw: Readonly<Record<string, unknown>>): string {
  const response = raw["response"];
  if (response === null || typeof response !== "object") return "";
  const project = (response as Record<string, unknown>)["cloudaicompanionProject"];
  if (project === null || typeof project !== "object") return "";
  const id = (project as Record<string, unknown>)["id"];
  return typeof id === "string" ? id : "";
}
