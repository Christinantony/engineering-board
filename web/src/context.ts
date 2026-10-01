import { createContext, useContext } from 'react';
import type { JobType, User } from '@board/shared';

export interface Meta {
  version: string;
  tz: string;
  today: string;
  estimates: { label: string; minutes: number }[];
  pin_is_default: boolean;
  workday: { hours_per_day: number; working_days: number[] };
  demo_present: boolean;
}

export interface AppState {
  me: User;
  users: User[];
  engineers: User[];
  jobTypes: JobType[];
  meta: Meta;
  user(id: number | null | undefined): User | undefined;
  jobType(id: number | null | undefined): JobType | undefined;
  openJob(id: number | null): void;
  newJob(): void;
}

export const AppContext = createContext<AppState>(null as unknown as AppState);
export const useApp = () => useContext(AppContext);
