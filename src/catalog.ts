import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DomainError, ReviewStore, type ReviewState } from './domain.js';

export interface ProjectSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  sessionCount: number;
}
export interface SessionSummary {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  claimCount: number;
  resourceCount: number;
  decisionCount: number;
  fixture: boolean;
  reviewStatus: ReviewState['reviewStatus'];
}
export interface CatalogState {
  schemaVersion: 'research-locus.catalog.v1';
  revision: number;
  projects: ProjectSummary[];
  sessions: SessionSummary[];
}

const LEGACY_SESSION_ID = 'legacy';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const PROJECT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/;
function clone<T>(value: T): T { return structuredClone(value); }
function title(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 240 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new DomainError('INVALID_TITLE', 'Title must contain 1–240 characters without control characters.');
  }
  return value.trim();
}
function sessionId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || (value !== LEGACY_SESSION_ID && !UUID.test(value))) throw new DomainError('INVALID_SESSION_ID', 'Session ID must be a recorded UUID or the legacy session ID.');
}
function projectId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !PROJECT_ID.test(value)) throw new DomainError('INVALID_PROJECT_ID', 'Project ID contains unsupported characters.');
}
function timestamp(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT.*Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('invalid timestamp');
}
function count(value: unknown): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('invalid count');
}
function summarize(id: string, project: string, sessionTitle: string, state: ReviewState, createdAt?: string): SessionSummary {
  const first = state.events[0]?.at;
  const last = state.events.at(-1)?.at;
  if (!first || !last) throw new DomainError('CATALOG_INTEGRITY_ERROR', 'Review session has no recorded event history.', 500);
  return {
    id, projectId: project, title: sessionTitle, createdAt: createdAt ?? first, updatedAt: last,
    revision: state.revision, claimCount: state.claims.length, resourceCount: state.resources.length,
    decisionCount: state.decisions.length, fixture: state.fixture, reviewStatus: state.reviewStatus,
  };
}

/** Project/session navigation only. A session is one actual ReviewStore, never a fabricated chat transcript. */
export class WorkspaceCatalog {
  readonly defaultSessionId = LEGACY_SESSION_ID;
  private readonly directory: string | undefined;
  private readonly legacyStore: ReviewStore;
  private readonly stores = new Map<string, ReviewStore>();
  private state: CatalogState;

  constructor(options: { directory?: string; legacyStore: ReviewStore }) {
    this.directory = options.directory === undefined ? undefined : resolve(options.directory);
    this.legacyStore = options.legacyStore;
    const legacy = this.legacyStore.getState();
    projectId(legacy.projectId);
    const session = summarize(LEGACY_SESSION_ID, legacy.projectId, legacy.title, legacy);
    this.state = {
      schemaVersion: 'research-locus.catalog.v1', revision: 0,
      projects: [{ id: legacy.projectId, title: legacy.title, createdAt: session.createdAt, updatedAt: session.updatedAt, sessionCount: 1 }],
      sessions: [session],
    };
    this.stores.set(LEGACY_SESSION_ID, this.legacyStore);
    if (this.directory) {
      mkdirSync(this.directory, { recursive: true });
      const sessions = join(this.directory, 'sessions');
      if (existsSync(sessions) && lstatSync(sessions).isSymbolicLink()) throw new DomainError('CATALOG_INTEGRITY_ERROR', 'Session directory must not be a symbolic link.', 500);
      mkdirSync(sessions, { recursive: true });
      this.lock(() => {
        if (existsSync(this.catalogPath())) this.state = this.read();
        else this.persist(this.state);
      });
    }
  }

  list(): CatalogState {
    return this.lock(() => {
      const current = this.reload();
      const next = this.refresh(current);
      if (JSON.stringify(next) !== JSON.stringify(current)) {
        next.revision = current.revision + 1;
        this.persist(next);
      }
      this.state = next;
      return clone(next);
    });
  }

  createProject(projectTitle: string): CatalogState {
    const name = title(projectTitle);
    return this.lock(() => {
      const current = this.reload();
      if (current.projects.length >= 1000) throw new DomainError('PROJECT_LIMIT', 'This prototype supports at most 1000 projects.', 413);
      const next = this.refresh(current);
      const now = new Date().toISOString();
      next.projects.push({ id: randomUUID(), title: name, createdAt: now, updatedAt: now, sessionCount: 0 });
      next.revision = current.revision + 1;
      this.persist(next);
      this.state = next;
      return clone(next);
    });
  }

  createSession(project: string, sessionTitle: string): { catalog: CatalogState; sessionId: string; state: ReviewState } {
    projectId(project);
    const name = title(sessionTitle);
    return this.lock(() => {
      const current = this.reload();
      if (!current.projects.some(item => item.id === project)) throw new DomainError('PROJECT_NOT_FOUND', 'Project does not exist.', 404);
      if (current.sessions.length >= 5000) throw new DomainError('SESSION_LIMIT', 'This prototype supports at most 5000 sessions.', 413);
      const next = this.refresh(current);
      const id = randomUUID();
      const store = new ReviewStore({ ...(this.directory ? { filePath: this.sessionPath(id) } : {}), initial: { projectId: project, title: name } });
      const state = store.getState();
      this.stores.set(id, store);
      next.sessions.push(summarize(id, project, name, state));
      const summary = next.projects.find(item => item.id === project)!;
      summary.sessionCount += 1;
      summary.updatedAt = state.events[0]!.at;
      next.revision = current.revision + 1;
      // The session file is written first. Failed catalog publication preserves an
      // orphan file for operator recovery; it never invents a catalog conversation.
      this.persist(next);
      this.state = next;
      return { catalog: clone(next), sessionId: id, state };
    });
  }

  getStore(id: string): ReviewStore {
    sessionId(id);
    const current = this.reload();
    const session = current.sessions.find(item => item.id === id);
    if (!session) throw new DomainError('SESSION_NOT_FOUND', 'Session does not exist.', 404);
    return this.resolveStore(session);
  }

  private refresh(current: CatalogState): CatalogState {
    const next = clone(current);
    next.sessions = current.sessions.map(session => {
      const state = this.resolveStore(session).getState();
      if (state.projectId !== session.projectId || state.title !== session.title) throw new DomainError('CATALOG_INTEGRITY_ERROR', 'Session state does not match its catalog project/title binding.', 500);
      return summarize(session.id, session.projectId, session.title, state, session.createdAt);
    });
    next.projects = current.projects.map(project => {
      const sessions = next.sessions.filter(session => session.projectId === project.id);
      return { ...project, sessionCount: sessions.length, updatedAt: sessions.reduce((latest, session) => session.updatedAt > latest ? session.updatedAt : latest, project.createdAt) };
    });
    return next;
  }

  private resolveStore(session: SessionSummary): ReviewStore {
    const cached = this.stores.get(session.id);
    if (cached) return cached;
    if (!this.directory) throw new DomainError('SESSION_NOT_FOUND', 'Session has no in-memory state.', 404);
    const filePath = this.sessionPath(session.id);
    if (existsSync(filePath) && lstatSync(filePath).isSymbolicLink()) throw new DomainError('CATALOG_INTEGRITY_ERROR', 'Session file must not be a symbolic link.', 500);
    const store = new ReviewStore({ filePath, requireExisting: true });
    this.stores.set(session.id, store);
    return store;
  }

  private reload(): CatalogState { return this.directory ? this.read() : clone(this.state); }
  private catalogPath(): string { return join(this.directory!, 'catalog.json'); }
  private sessionPath(id: string): string {
    sessionId(id);
    if (id === LEGACY_SESSION_ID) throw new DomainError('INVALID_SESSION_ID', 'Legacy state is referenced directly and is never copied to a session file.');
    return join(this.directory!, 'sessions', `${id}.json`);
  }

  private read(): CatalogState {
    try {
      const value = JSON.parse(readFileSync(this.catalogPath(), 'utf8')) as CatalogState;
      if (value.schemaVersion !== 'research-locus.catalog.v1' || !Array.isArray(value.projects) || !Array.isArray(value.sessions)) throw new Error('unsupported catalog schema');
      count(value.revision);
      if (value.projects.length > 1000 || value.sessions.length > 5000) throw new Error('catalog exceeds supported size');
      const projects = new Set<string>();
      for (const project of value.projects) {
        projectId(project.id); title(project.title); timestamp(project.createdAt); timestamp(project.updatedAt); count(project.sessionCount);
        if (projects.has(project.id)) throw new Error('duplicate project ID');
        projects.add(project.id);
      }
      const sessions = new Set<string>();
      for (const session of value.sessions) {
        sessionId(session.id); projectId(session.projectId); title(session.title); timestamp(session.createdAt); timestamp(session.updatedAt);
        for (const number of [session.revision, session.claimCount, session.resourceCount, session.decisionCount]) count(number);
        if (!projects.has(session.projectId) || sessions.has(session.id) || typeof session.fixture !== 'boolean' || !['active', 'paused'].includes(session.reviewStatus)) throw new Error('invalid session record');
        sessions.add(session.id);
      }
      const legacy = value.sessions.find(session => session.id === LEGACY_SESSION_ID);
      if (!legacy || legacy.projectId !== this.legacyStore.getState().projectId) throw new Error('legacy project binding does not match');
      return value;
    } catch (error) {
      throw new DomainError('CATALOG_INTEGRITY_ERROR', `Cannot read workspace catalog: ${error instanceof Error ? error.message : 'invalid catalog'}. Existing files were preserved.`, 500);
    }
  }

  private persist(state: CatalogState): void {
    if (!this.directory) return;
    const destination = this.catalogPath();
    const temporary = `${destination}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporary, 'wx', 0o600);
      writeFileSync(descriptor, JSON.stringify(state, null, 2), 'utf8');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, destination);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }

  private lock<T>(operation: () => T): T {
    if (!this.directory) return operation();
    const lockPath = join(this.directory, 'catalog.lock');
    let descriptor: number;
    try { descriptor = openSync(lockPath, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new DomainError('CATALOG_LOCKED', 'Another process is updating the workspace catalog. Retry after it finishes; stale locks require operator inspection.', 409);
      throw error;
    }
    try { return operation(); }
    finally { closeSync(descriptor); unlinkSync(lockPath); }
  }
}
