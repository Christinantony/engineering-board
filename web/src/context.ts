import { createContext, useContext } from 'react';
import type { JobType, Project, User, Capability, RolePermissions } from '@board/shared';

export interface Meta {
  version: string;
  tz: string;
  today: string;
  estimates: { label: string; minutes: number }[];
  pin_is_default: boolean;
  workday: { hours_per_day: number; working_days: number[] };
  demo_present: boolean;
  /** What each role may do with jobs (Admin → Roles, decision #31). */
  permissions: RolePermissions;
}

export interface AppState {
  me: User;
  users: User[];
  /** People whose role can claim and be assigned jobs (Admin → Roles). */
  workers: User[];
  jobTypes: JobType[];
  /** Projects, sorted by name (empty for reviewers, who don't see projects). */
  projects: Project[];
  meta: Meta;
  /** Does the signed-in person have this job capability? */
  can(cap: Capability): boolean;
  /** Can the signed-in person change this job (edit any job, or claim-holders on their own job)? */
  canChange(t: { assigned_to: number | null }): boolean;
  user(id: number | null | undefined): User | undefined;
  jobType(id: number | null | undefined): JobType | undefined;
  project(id: number | null | undefined): Project | undefined;
  openJob(id: number | null): void;
  newJob(): void;
}

export const AppContext = createContext<AppState>(null as unknown as AppState);
export const useApp = () => useContext(AppContext);
