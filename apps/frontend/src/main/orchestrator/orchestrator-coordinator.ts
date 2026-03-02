/**
 * OrchestratorCoordinator
 *
 * Event-driven coordinator for orchestrator meta-tasks.
 * Manages child task lifecycle: creation, dependency resolution, and sequential merge.
 *
 * Flow:
 *   1. Decomposition agent completes → onDecompositionComplete() is called
 *   2. Reads decomposition.json → creates child tasks → starts independent ones
 *   3. Listens for child task status changes → starts dependent children
 *   4. All children done → triggers sequential merge → parent to human_review
 */
import { ipcMain, BrowserWindow } from 'electron';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, type Dirent } from 'fs';
import path from 'path';
import { IPC_CHANNELS, AUTO_BUILD_PATHS, getSpecsDir } from '../../shared/constants';
import type { Task, TaskMetadata } from '../../shared/types';
import { writeFileAtomicSync } from '../utils/atomic-file';
import { projectStore } from '../project-store';

// ---- Types ----

export interface Workstream {
  id: string;
  title: string;
  description: string;
  depends_on: string[];
  estimated_files?: string[];
  child_spec_id: string | null;
  status: 'pending' | 'running' | 'completed' | 'failed';
}

export interface Decomposition {
  workstreams: Workstream[];
  merge_order: string[];
  total_workstreams: number;
  independent_count: number;
  max_parallel: number;
}

interface OrchestratorState {
  parentTaskId: string;
  parentSpecId: string;
  projectId: string;
  projectPath: string;
  decomposition: Decomposition;
  childTaskMap: Map<string, string>; // workstream id -> child task id (specId)
  specDir: string;
}

// ---- Singleton State ----

/** Active orchestrator states, keyed by parent task ID */
const activeOrchestrators = new Map<string, OrchestratorState>();

// ---- Utility Functions ----

function getMainWindow(): BrowserWindow | null {
  const windows = BrowserWindow.getAllWindows();
  return windows.length > 0 ? windows[0] : null;
}

/**
 * Load decomposition.json from a spec directory.
 * Returns null if file doesn't exist or is invalid.
 */
function loadDecomposition(specDir: string): Decomposition | null {
  const decompositionPath = path.join(specDir, 'decomposition.json');
  if (!existsSync(decompositionPath)) {
    console.warn('[Orchestrator] decomposition.json not found:', decompositionPath);
    return null;
  }

  try {
    const content = readFileSync(decompositionPath, 'utf-8');
    return JSON.parse(content) as Decomposition;
  } catch (error) {
    console.warn('[Orchestrator] Failed to parse decomposition.json:', error);
    return null;
  }
}

/**
 * Save updated decomposition.json back to disk atomically.
 */
function saveDecomposition(specDir: string, decomposition: Decomposition): void {
  const decompositionPath = path.join(specDir, 'decomposition.json');
  writeFileAtomicSync(decompositionPath, JSON.stringify(decomposition, null, 2));
}

/**
 * Update parent task metadata with orchestrator status and child task IDs.
 * Merges updates into existing metadata, preserving other fields.
 */
function updateParentMetadata(
  specDir: string,
  updates: Partial<TaskMetadata>
): void {
  const metadataPath = path.join(specDir, 'task_metadata.json');
  try {
    let metadata: TaskMetadata = {};
    if (existsSync(metadataPath)) {
      metadata = JSON.parse(readFileSync(metadataPath, 'utf-8'));
    }
    Object.assign(metadata, updates);
    writeFileAtomicSync(metadataPath, JSON.stringify(metadata, null, 2));
  } catch (error) {
    console.warn('[Orchestrator] Failed to update parent metadata:', error);
  }
}

/**
 * Perform topological sort on workstreams (Kahn's algorithm).
 * Throws if a cycle is detected.
 */
function topologicalSort(workstreams: Workstream[]): string[] {
  const ids = new Set(workstreams.map(ws => ws.id));
  const inDegree = new Map<string, number>();
  const graph = new Map<string, string[]>();

  for (const id of ids) {
    inDegree.set(id, 0);
    graph.set(id, []);
  }

  for (const ws of workstreams) {
    for (const dep of ws.depends_on) {
      if (ids.has(dep)) {
        graph.get(dep)!.push(ws.id);
        inDegree.set(ws.id, (inDegree.get(ws.id) || 0) + 1);
      }
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    sorted.push(node);
    for (const neighbor of graph.get(node) || []) {
      const newDeg = (inDegree.get(neighbor) || 1) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  if (sorted.length !== ids.size) {
    throw new Error('Dependency cycle detected in workstreams');
  }

  return sorted;
}

/**
 * Get workstreams that are ready to start (all dependencies completed).
 */
function getReadyWorkstreams(decomposition: Decomposition): Workstream[] {
  const completedIds = new Set(
    decomposition.workstreams
      .filter(ws => ws.status === 'completed')
      .map(ws => ws.id)
  );

  return decomposition.workstreams.filter(ws => {
    if (ws.status !== 'pending') return false;
    return ws.depends_on.every(dep => completedIds.has(dep));
  });
}

/** Check if all workstreams are done (completed or failed) */
function allWorkstreamsDone(decomposition: Decomposition): boolean {
  return decomposition.workstreams.every(
    ws => ws.status === 'completed' || ws.status === 'failed'
  );
}

/** Check if any workstream failed */
function hasFailures(decomposition: Decomposition): boolean {
  return decomposition.workstreams.some(ws => ws.status === 'failed');
}

/**
 * Get inherited metadata from parent task for child tasks.
 * Copies agent configuration (model, thinking, QA settings) so children
 * use the same configuration as the parent.
 */
function getInheritedMetadata(specDir: string): Partial<TaskMetadata> {
  const metadataPath = path.join(specDir, 'task_metadata.json');
  try {
    if (existsSync(metadataPath)) {
      const metadata = JSON.parse(readFileSync(metadataPath, 'utf-8')) as TaskMetadata;
      return {
        model: metadata.model,
        thinkingLevel: metadata.thinkingLevel,
        isAutoProfile: metadata.isAutoProfile,
        phaseModels: metadata.phaseModels,
        phaseThinking: metadata.phaseThinking,
        fastMode: metadata.fastMode,
        qaMode: metadata.qaMode,
        memoryBackend: metadata.memoryBackend,
        maxQaIterations: metadata.maxQaIterations,
        baseBranch: metadata.baseBranch,
      };
    }
  } catch {
    // Ignore parse errors — children will use defaults
  }
  return {};
}

/**
 * Create a child task directly in the file system.
 * Mirrors the TASK_CREATE IPC handler logic in crud-handlers.ts:
 *   1. Generate spec ID from next available number
 *   2. Create spec directory
 *   3. Write task_metadata.json
 *   4. Write implementation_plan.json (empty, pending)
 *   5. Write requirements.json
 *
 * Returns the specId on success, null on failure.
 */
function createChildTask(
  projectId: string,
  projectPath: string,
  title: string,
  description: string,
  metadata: TaskMetadata
): string | null {
  try {
    const project = projectStore.getProject(projectId);
    if (!project) {
      console.warn('[Orchestrator] Project not found:', projectId);
      return null;
    }

    // Resolve specs directory (same logic as crud-handlers.ts)
    const specsBaseDir = getSpecsDir(project.autoBuildPath);
    const specsDir = path.join(projectPath, specsBaseDir);

    // Find next available spec number
    let specNumber = 1;
    if (existsSync(specsDir)) {
      const existingDirs = readdirSync(specsDir, { withFileTypes: true })
        .filter((d: Dirent) => d.isDirectory())
        .map((d: Dirent) => d.name);

      const existingNumbers = existingDirs
        .map((name: string) => {
          const match = name.match(/^(\d+)/);
          return match ? parseInt(match[1], 10) : 0;
        })
        .filter((n: number) => n > 0);

      if (existingNumbers.length > 0) {
        specNumber = Math.max(...existingNumbers) + 1;
      }
    }

    // Create spec ID with zero-padded number and slugified title
    const slugifiedTitle = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 50);
    const specId = `${String(specNumber).padStart(3, '0')}-${slugifiedTitle}`;

    // Create spec directory
    const specDir = path.join(specsDir, specId);
    mkdirSync(specDir, { recursive: true });

    // Write task metadata
    const taskMetadata: TaskMetadata = {
      sourceType: 'orchestrator',
      ...metadata,
    };
    const metadataPath = path.join(specDir, 'task_metadata.json');
    writeFileSync(metadataPath, JSON.stringify(taskMetadata, null, 2), 'utf-8');

    // Create initial implementation_plan.json (empty, pending)
    const now = new Date().toISOString();
    const implementationPlan = {
      feature: title,
      description,
      created_at: now,
      updated_at: now,
      status: 'pending',
      phases: [],
    };
    const planPath = path.join(specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);
    writeFileSync(planPath, JSON.stringify(implementationPlan, null, 2), 'utf-8');

    // Create requirements.json
    const requirements = {
      task_description: description,
      workflow_type: metadata.category || 'feature',
    };
    const requirementsPath = path.join(specDir, AUTO_BUILD_PATHS.REQUIREMENTS);
    writeFileSync(requirementsPath, JSON.stringify(requirements, null, 2), 'utf-8');

    // Invalidate cache since a new task was created
    projectStore.invalidateTasksCache(projectId);

    console.warn(`[Orchestrator] Created child task spec: ${specId} in ${specDir}`);
    return specId;
  } catch (error) {
    console.warn('[Orchestrator] Failed to create child task:', error);
    return null;
  }
}

// ---- Public API ----

/**
 * Called after decomposition agent completes successfully.
 * Reads decomposition.json, creates child tasks, and starts independent ones.
 */
export async function onDecompositionComplete(
  parentTaskId: string,
  parentSpecId: string,
  projectId: string,
  projectPath: string,
  specDir: string
): Promise<void> {
  console.warn('[Orchestrator] Decomposition complete for:', parentSpecId);

  const decomposition = loadDecomposition(specDir);
  if (!decomposition) {
    console.warn('[Orchestrator] No valid decomposition found — failing parent task');
    const mainWindow = getMainWindow();
    mainWindow?.webContents.send(IPC_CHANNELS.TASK_ERROR, parentTaskId, 'Decomposition failed: no valid decomposition.json produced');
    return;
  }

  // Validate DAG and compute merge order
  let mergeOrder: string[];
  try {
    mergeOrder = topologicalSort(decomposition.workstreams);
    decomposition.merge_order = mergeOrder;
    saveDecomposition(specDir, decomposition);
  } catch (error) {
    console.warn('[Orchestrator] Invalid dependency graph:', error);
    const mainWindow = getMainWindow();
    mainWindow?.webContents.send(IPC_CHANNELS.TASK_ERROR, parentTaskId, 'Decomposition failed: dependency cycle detected');
    return;
  }

  // Create orchestrator state
  const state: OrchestratorState = {
    parentTaskId,
    parentSpecId,
    projectId,
    projectPath,
    decomposition,
    childTaskMap: new Map(),
    specDir,
  };

  activeOrchestrators.set(parentTaskId, state);

  // Create child tasks for each workstream
  const childSpecIds: string[] = [];
  const inheritedMetadata = getInheritedMetadata(specDir);

  for (const ws of decomposition.workstreams) {
    const childMetadata: TaskMetadata = {
      sourceType: 'orchestrator',
      parentTaskId: parentSpecId,
      ...inheritedMetadata,
    };

    const childSpecId = createChildTask(
      projectId,
      projectPath,
      ws.title,
      ws.description,
      childMetadata
    );

    if (childSpecId) {
      ws.child_spec_id = childSpecId;
      state.childTaskMap.set(ws.id, childSpecId);
      childSpecIds.push(childSpecId);
      console.warn(`[Orchestrator] Created child task ${childSpecId} for workstream ${ws.id}: ${ws.title}`);
    } else {
      console.warn(`[Orchestrator] Failed to create child task for workstream ${ws.id}`);
      ws.status = 'failed';
    }
  }

  // Update parent metadata with child task IDs
  updateParentMetadata(specDir, {
    orchestratorStatus: 'running',
    childTaskIds: childSpecIds,
  });

  // Save updated decomposition with child spec IDs
  saveDecomposition(specDir, decomposition);

  // Start workstreams with no dependencies
  const ready = getReadyWorkstreams(decomposition);
  console.warn(`[Orchestrator] Starting ${ready.length} independent workstream(s)`);

  for (const ws of ready) {
    const childSpecId = state.childTaskMap.get(ws.id);
    if (childSpecId) {
      ws.status = 'running';
      // Trigger TASK_START for the child task via IPC
      // The childSpecId is the task ID (specId === id in Auto Claude)
      ipcMain.emit(IPC_CHANNELS.TASK_START, { sender: getMainWindow()?.webContents }, childSpecId);
    }
  }

  saveDecomposition(specDir, decomposition);

  // Notify renderer of orchestrator status
  const mainWindow = getMainWindow();
  mainWindow?.webContents.send('orchestrator:status', parentTaskId, {
    status: 'running',
    total: decomposition.workstreams.length,
    completed: 0,
    running: ready.length,
    pending: decomposition.workstreams.length - ready.length,
  });
}

/**
 * Called when a child task changes status.
 * Checks if dependent workstreams can start, and triggers merge when all done.
 *
 * This should be called from the task state manager when any task status changes.
 */
export function onChildTaskStatusChange(
  childTaskId: string,
  newStatus: string
): void {
  // Find which orchestrator owns this child
  let parentState: OrchestratorState | null = null;
  let workstreamId: string | null = null;

  for (const [, state] of activeOrchestrators) {
    for (const [wsId, ctId] of state.childTaskMap) {
      if (ctId === childTaskId) {
        parentState = state;
        workstreamId = wsId;
        break;
      }
    }
    if (parentState) break;
  }

  if (!parentState || !workstreamId) return; // Not an orchestrator child

  const ws = parentState.decomposition.workstreams.find(w => w.id === workstreamId);
  if (!ws) return;

  // Update workstream status based on child task status
  if (newStatus === 'done' || newStatus === 'human_review') {
    ws.status = 'completed';
    console.warn(`[Orchestrator] Workstream ${workstreamId} completed (child: ${childTaskId})`);
  } else if (newStatus === 'error') {
    ws.status = 'failed';
    console.warn(`[Orchestrator] Workstream ${workstreamId} failed (child: ${childTaskId})`);
  } else {
    return; // Intermediate status (in_progress, queue, etc.) — don't take action
  }

  saveDecomposition(parentState.specDir, parentState.decomposition);

  // Check if all done
  if (allWorkstreamsDone(parentState.decomposition)) {
    handleAllWorkstreamsComplete(parentState);
    return;
  }

  // Check for newly unblocked workstreams
  const ready = getReadyWorkstreams(parentState.decomposition);
  if (ready.length > 0) {
    console.warn(`[Orchestrator] ${ready.length} workstream(s) unblocked`);
    for (const readyWs of ready) {
      const childId = parentState.childTaskMap.get(readyWs.id);
      if (childId) {
        readyWs.status = 'running';
        ipcMain.emit(IPC_CHANNELS.TASK_START, { sender: getMainWindow()?.webContents }, childId);
      }
    }
    saveDecomposition(parentState.specDir, parentState.decomposition);
  }

  // Notify renderer of progress
  const completed = parentState.decomposition.workstreams.filter(w => w.status === 'completed').length;
  const running = parentState.decomposition.workstreams.filter(w => w.status === 'running').length;
  const failed = parentState.decomposition.workstreams.filter(w => w.status === 'failed').length;
  const pending = parentState.decomposition.workstreams.filter(w => w.status === 'pending').length;

  const mainWindow = getMainWindow();
  mainWindow?.webContents.send('orchestrator:status', parentState.parentTaskId, {
    status: hasFailures(parentState.decomposition) ? 'partial_failure' : 'running',
    total: parentState.decomposition.workstreams.length,
    completed,
    running,
    failed,
    pending,
  });
}

/**
 * Handle all workstreams complete — trigger merge phase.
 * Merges child worktrees sequentially in dependency order.
 */
async function handleAllWorkstreamsComplete(state: OrchestratorState): Promise<void> {
  const hasFailed = hasFailures(state.decomposition);

  console.warn(`[Orchestrator] All workstreams complete for ${state.parentSpecId}. Failures: ${hasFailed}`);

  // Update parent status
  updateParentMetadata(state.specDir, {
    orchestratorStatus: hasFailed ? 'partial_failure' : 'merging',
  });

  const mainWindow = getMainWindow();
  mainWindow?.webContents.send('orchestrator:status', state.parentTaskId, {
    status: hasFailed ? 'partial_failure' : 'merging',
    total: state.decomposition.workstreams.length,
    completed: state.decomposition.workstreams.filter(w => w.status === 'completed').length,
    failed: state.decomposition.workstreams.filter(w => w.status === 'failed').length,
    running: 0,
    pending: 0,
  });

  // Merge child worktrees sequentially in dependency order
  const mergeOrder = state.decomposition.merge_order;
  let allMergesSucceeded = true;
  const mergeErrors: string[] = [];

  for (const wsId of mergeOrder) {
    const ws = state.decomposition.workstreams.find(w => w.id === wsId);
    if (!ws || ws.status !== 'completed') continue;

    const childSpecId = state.childTaskMap.get(wsId);
    if (!childSpecId) continue;

    console.warn(`[Orchestrator] Merging workstream ${wsId} (child: ${childSpecId})`);

    try {
      // Notify renderer which workstream is being merged
      mainWindow?.webContents.send('orchestrator:merging-workstream', state.parentTaskId, wsId, ws.title);

      // Trigger worktree merge via IPC invoke (WORKTREE_MERGE handler)
      // The existing merge handler stages changes from the child's worktree
      // into the main project directory
      console.warn(`[Orchestrator] Triggering merge for child task ${childSpecId}`);
      // TODO: Call the worktree merge handler directly when the merge integration
      // is fully wired. For now the user can merge each child manually from human_review.

    } catch (error) {
      console.warn(`[Orchestrator] Merge failed for ${wsId}:`, error);
      allMergesSucceeded = false;
      mergeErrors.push(`${ws.title}: ${error}`);
    }
  }

  // Update final status
  const finalStatus = !allMergesSucceeded ? 'partial_failure'
    : hasFailed ? 'partial_failure'
    : 'completed';

  updateParentMetadata(state.specDir, {
    orchestratorStatus: finalStatus,
  });

  // Move parent to human_review for final approval
  mainWindow?.webContents.send('orchestrator:complete', state.parentTaskId, {
    status: finalStatus,
    mergeErrors,
    total: state.decomposition.workstreams.length,
    completed: state.decomposition.workstreams.filter(w => w.status === 'completed').length,
    failed: state.decomposition.workstreams.filter(w => w.status === 'failed').length,
  });

  // Clean up in-memory state
  activeOrchestrators.delete(state.parentTaskId);
}

/**
 * Stop all children of an orchestrator task.
 * Called when the user stops the parent task.
 */
export function stopOrchestratorChildren(parentTaskId: string): void {
  const state = activeOrchestrators.get(parentTaskId);
  if (!state) return;

  console.warn(`[Orchestrator] Stopping all children for ${parentTaskId}`);

  for (const [wsId, childTaskId] of state.childTaskMap) {
    const ws = state.decomposition.workstreams.find(w => w.id === wsId);
    if (ws && ws.status === 'running') {
      ipcMain.emit(IPC_CHANNELS.TASK_STOP, {}, childTaskId);
      ws.status = 'pending'; // Reset to pending so it can be restarted
    }
  }

  saveDecomposition(state.specDir, state.decomposition);
  updateParentMetadata(state.specDir, {
    orchestratorStatus: 'partial_failure',
  });

  activeOrchestrators.delete(state.parentTaskId);
}

/**
 * Recover orchestrator state on app restart.
 * Scans for orchestrator tasks and re-registers in-memory state
 * so child status changes are properly tracked.
 */
export function recoverOrchestratorState(
  tasks: Task[],
  projectPath: string,
  projectId: string
): void {
  for (const task of tasks) {
    if (!task.metadata?.isOrchestratorTask) continue;
    if (task.status === 'done' || task.status === 'pr_created') continue;

    const orchestratorStatus = task.metadata.orchestratorStatus;
    if (!orchestratorStatus || orchestratorStatus === 'completed') continue;

    console.warn(`[Orchestrator] Recovering orchestrator task: ${task.specId}, status: ${orchestratorStatus}`);

    // Re-load decomposition and rebuild state
    if (task.specsPath) {
      const decomposition = loadDecomposition(task.specsPath);
      if (decomposition && task.metadata.childTaskIds) {
        const state: OrchestratorState = {
          parentTaskId: task.id,
          parentSpecId: task.specId,
          projectId,
          projectPath,
          decomposition,
          childTaskMap: new Map(),
          specDir: task.specsPath,
        };

        // Rebuild child task map from decomposition
        for (const ws of decomposition.workstreams) {
          if (ws.child_spec_id) {
            // In Auto Claude, specId === task.id, so child_spec_id is the task ID
            state.childTaskMap.set(ws.id, ws.child_spec_id);
          }
        }

        activeOrchestrators.set(task.id, state);
        console.warn(`[Orchestrator] Recovered state for ${task.specId} with ${state.childTaskMap.size} children`);
      }
    }
  }
}

/**
 * Check if a task is a child of any active orchestrator.
 */
export function isOrchestratorChild(taskId: string): boolean {
  for (const [, state] of activeOrchestrators) {
    for (const [, childId] of state.childTaskMap) {
      if (childId === taskId) return true;
    }
  }
  return false;
}

/**
 * Get the parent orchestrator task ID for a child task.
 * Returns null if the task is not a child of any orchestrator.
 */
export function getParentOrchestratorId(childTaskId: string): string | null {
  for (const [parentId, state] of activeOrchestrators) {
    for (const [, childId] of state.childTaskMap) {
      if (childId === childTaskId) return parentId;
    }
  }
  return null;
}
