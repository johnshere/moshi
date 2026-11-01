/**
 * 仓储聚合（详设 §3.4 的 `buildRepos`）。
 *
 * 业务代码只拿到这个对象，拿不到 `Db` 本身——这是"业务代码拿不到裸 SQL"的实现方式。
 * 需要新查询时，在这里加方法，不要在 core 里写 SQL。
 */
import type { Db } from './db.js';
import * as audit from './auditRepo.js';
import * as edges from './edgeRepo.js';
import * as entities from './entityRepo.js';
import * as facts from './factRepo.js';
import * as views from './views.js';

export interface Repos {
  fact: typeof facts;
  edge: typeof edges;
  entity: typeof entities;
  audit: typeof audit;
  view: typeof views;
}

export function buildRepos(_db: Db): Repos {
  return { fact: facts, edge: edges, entity: entities, audit, view: views };
}
