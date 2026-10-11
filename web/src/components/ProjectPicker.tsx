// Choose a job's project, or add a new one on the spot (decision #30).
// Projects aren't preset: the first job of a new project adds it.

import type { Project } from '@board/shared';
import { useApp } from '../context.ts';
import { ApiError, post } from '../lib/api.ts';
import { ask } from '../lib/dialogs.ts';
import { invalidate, setCached } from '../lib/store.ts';
import { toast, toastError } from '../lib/toasts.ts';

const ADD = '__add__';

/** Ask for a name and add the project. Returns the project (an existing one if the name is taken), or null. */
export async function addProject(): Promise<Project | null> {
  const name = await ask({
    type: 'text',
    title: 'Add a project',
    body: 'Projects are added as they are needed. Use the name the team knows it by; each name can be used once.',
    label: 'Project name',
    confirm: 'Add project',
    required: true,
  });
  if (!name?.trim()) return null;
  try {
    const { project } = await post<{ project: Project }>('/api/projects', { name });
    setCached<{ projects: Project[] }>('/api/projects', (prev) => ({
      projects: [...(prev?.projects ?? []), project].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
    }));
    invalidate('/api/projects');
    toast(`Project "${project.name}" added`, { kind: 'success' });
    return project;
  } catch (e) {
    if (e instanceof ApiError && e.code === 'project_exists' && e.body?.project) {
      toast(`"${e.body.project.name}" already exists, so it was chosen`, { kind: 'info' });
      return e.body.project as Project;
    }
    toastError(e);
    return null;
  }
}

export function ProjectPicker({
  value,
  onChange,
  id,
  required,
  className = 'field-input',
  label = 'Project',
}: {
  value: number | null;
  onChange: (id: number) => void;
  id?: string;
  required?: boolean;
  className?: string;
  label?: string;
}) {
  const { projects } = useApp();
  return (
    <select
      id={id}
      className={className}
      aria-label={label}
      aria-required={required || undefined}
      value={value ?? ''}
      onChange={async (e: any) => {
        const v = e.target.value;
        if (v === ADD) {
          e.target.value = value ?? '';
          const p = await addProject();
          if (p) onChange(p.id);
        } else if (v) onChange(Number(v));
      }}
    >
      <option value="" disabled>
        {projects.length ? 'Choose a project…' : 'No projects yet: add one'}
      </option>
      {projects.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
      <option value={ADD}>+ Add a project…</option>
    </select>
  );
}
