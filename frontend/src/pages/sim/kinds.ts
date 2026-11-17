import { api } from '../../api';
import { newPersona, newRubric, newScenario, personaPayload, rubricPayload, scenarioPayload } from '../../lib/util';
import type { PersonaDef, PersonaSummary, RubricDef, ScenarioDef } from '../../types';
import type { DefKind } from './defs';

export const PERSONA_KIND: DefKind<PersonaDef, PersonaSummary> = {
  label: 'persona',
  path: '/simulations/personas',
  kind: 'personas',
  get: api.personas.get,
  create: api.personas.create,
  update: api.personas.update,
  remove: api.personas.remove,
  payload: personaPayload,
  blank: newPersona,
};

export const SCENARIO_KIND: DefKind<ScenarioDef> = {
  label: 'scenario',
  path: '/simulations/scenarios',
  kind: 'scenarios',
  get: api.scenarios.get,
  create: api.scenarios.create,
  update: api.scenarios.update,
  remove: api.scenarios.remove,
  payload: scenarioPayload,
  blank: newScenario,
};

export const RUBRIC_KIND: DefKind<RubricDef> = {
  label: 'rubric',
  path: '/simulations/rubrics',
  kind: 'rubrics',
  get: api.rubrics.get,
  create: api.rubrics.create,
  update: api.rubrics.update,
  remove: api.rubrics.remove,
  payload: rubricPayload,
  blank: newRubric,
};
