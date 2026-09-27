import type { Project, ProjectCreate, Team, TeamCreate } from "../types.js";
import { Resource, seg, type CallOptions } from "./base.js";

/** Projects group datasets; non-admins see open projects and the ones they (or their teams) belong to. */
export class ProjectsResource extends Resource {
  list(options?: CallOptions): Promise<Project[]> {
    return this.http.request({ method: "GET", path: "/v1/projects", ...options });
  }

  /** Admin only. */
  create(body: ProjectCreate, options?: CallOptions): Promise<Project> {
    return this.http.request({ method: "POST", path: "/v1/projects", body: { open: false, members: [], ...body }, ...options });
  }

  addMember(projectId: string, userId: string, options?: CallOptions): Promise<Project> {
    return this.http.request({ method: "POST", path: `/v1/projects/${seg(projectId)}/members`, body: { user_id: userId }, ...options });
  }

  removeMember(projectId: string, userId: string, options?: CallOptions): Promise<void> {
    return this.http.request({ method: "DELETE", path: `/v1/projects/${seg(projectId)}/members/${seg(userId)}`, ...options });
  }

  /** Grant a team access to the project. */
  addTeam(projectId: string, teamId: string, options?: CallOptions): Promise<Project> {
    return this.http.request({ method: "POST", path: `/v1/projects/${seg(projectId)}/teams`, body: { team_id: teamId }, ...options });
  }

  removeTeam(projectId: string, teamId: string, options?: CallOptions): Promise<void> {
    return this.http.request({ method: "DELETE", path: `/v1/projects/${seg(projectId)}/teams/${seg(teamId)}`, ...options });
  }
}

/** Teams (AUTH-004). */
export class TeamsResource extends Resource {
  create(body: TeamCreate, options?: CallOptions): Promise<Team> {
    return this.http.request({ method: "POST", path: "/v1/teams", body, ...options });
  }

  list(options?: CallOptions): Promise<Team[]> {
    return this.http.request({ method: "GET", path: "/v1/teams", ...options });
  }

  get(teamId: string, options?: CallOptions): Promise<Team> {
    return this.http.request({ method: "GET", path: `/v1/teams/${seg(teamId)}`, ...options });
  }

  delete(teamId: string, options?: CallOptions): Promise<void> {
    return this.http.request({ method: "DELETE", path: `/v1/teams/${seg(teamId)}`, ...options });
  }

  addMember(teamId: string, userId: string, options?: CallOptions): Promise<Team> {
    return this.http.request({ method: "POST", path: `/v1/teams/${seg(teamId)}/members`, body: { user_id: userId }, ...options });
  }

  removeMember(teamId: string, userId: string, options?: CallOptions): Promise<void> {
    return this.http.request({ method: "DELETE", path: `/v1/teams/${seg(teamId)}/members/${seg(userId)}`, ...options });
  }
}
