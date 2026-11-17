import { useState } from 'react';
import { createBrowserRouter, Navigate, RouterProvider, type RouteObject } from 'react-router-dom';
import { Layout, NotFoundPage, RouteError } from './components/Layout';
import { AuthGate } from './lib/auth';
import { AccountPage } from './pages/auth/AccountPage';
import { UsersPage } from './pages/auth/UsersPage';
import { AgentEditor } from './pages/agents/AgentEditor';
import { AgentsList } from './pages/agents/AgentsList';
import { ChatIndex } from './pages/chat/ChatIndex';
import { ChatPage } from './pages/chat/ChatPage';
import { ComparePage } from './pages/data/ComparePage';
import { DatasetPage } from './pages/data/DatasetPage';
import { DatasetsList } from './pages/data/DatasetsList';
import { LinkEditor } from './pages/links/LinkEditor';
import { LinksPage } from './pages/links/LinksPage';
import { RetrieverEditor } from './pages/data/RetrieverEditor';
import { RetrieversList } from './pages/data/RetrieversList';
import { MemoryPage } from './pages/memory/MemoryPage';
import { ClassifierEditor } from './pages/safety/ClassifierEditor';
import { ClassifiersList } from './pages/safety/ClassifiersList';
import { SettingsPage } from './pages/settings/SettingsPage';
import { ConversationPage } from './pages/sim/ConversationDetail';
import { PersonasList, RubricsList, ScenariosList } from './pages/sim/DefinitionLists';
import { NewRunPage } from './pages/sim/NewRunPage';
import { PersonaEditor } from './pages/sim/PersonaEditor';
import { RubricEditor } from './pages/sim/RubricEditor';
import { RunPage } from './pages/sim/RunPage';
import { ScenarioEditor } from './pages/sim/ScenarioEditor';
import { SimulationsPage } from './pages/SimulationsPage';
import { SystemEditor } from './pages/systems/SystemEditor';
import { SystemsList } from './pages/systems/SystemsList';
import { SetupWizard } from './pages/wizard/SetupWizard';
import { TransferPage } from './pages/transfer/TransferPage';

const routes: RouteObject[] = [
  {
    path: '/',
    element: <Layout />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <Navigate to="/systems" replace /> },
      { path: 'agents', element: <AgentsList /> },
      { path: 'agents/:agentId', element: <AgentEditor /> },
      { path: 'systems', element: <SystemsList /> },
      { path: 'systems/:systemId', element: <SystemEditor /> },
      { path: 'setup', element: <SetupWizard /> },
      { path: 'safety', element: <ClassifiersList /> },
      { path: 'safety/:classifierId', element: <ClassifierEditor /> },
      { path: 'chat', element: <ChatIndex /> },
      // One route (optional chat id) so creating a chat does not remount the page mid-stream.
      { path: 'chat/:systemId/:chatId?', element: <ChatPage /> },
      { path: 'links', element: <LinksPage /> },
      { path: 'links/:linkId', element: <LinkEditor /> },
      { path: 'memory', element: <MemoryPage /> },
      { path: 'data', element: <Navigate to="/data/datasets" replace /> },
      { path: 'data/datasets', element: <DatasetsList /> },
      { path: 'data/datasets/:datasetId', element: <DatasetPage /> },
      { path: 'data/retrievers', element: <RetrieversList /> },
      { path: 'data/retrievers/:retrieverId', element: <RetrieverEditor /> },
      { path: 'data/compare', element: <ComparePage /> },
      // The old Library page now lives under Data.
      { path: 'library', element: <Navigate to="/data/datasets" replace /> },
      { path: 'simulations', element: <SimulationsPage /> },
      { path: 'simulations/runs', element: <Navigate to="/simulations" replace /> },
      { path: 'simulations/new', element: <NewRunPage /> },
      { path: 'simulations/runs/:runId', element: <RunPage /> },
      { path: 'simulations/conversations/:convId', element: <ConversationPage /> },
      { path: 'simulations/personas', element: <PersonasList /> },
      { path: 'simulations/personas/:personaId', element: <PersonaEditor /> },
      { path: 'simulations/scenarios', element: <ScenariosList /> },
      { path: 'simulations/scenarios/:scenarioId', element: <ScenarioEditor /> },
      { path: 'simulations/rubrics', element: <RubricsList /> },
      { path: 'simulations/rubrics/:rubricId', element: <RubricEditor /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'transfer', element: <TransferPage /> },
      { path: 'account', element: <AccountPage /> },
      { path: 'users', element: <UsersPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];

/** One router per signed-in session: it starts at the address bar's URL (after signing in: where the user was). */
function AppRouter() {
  const [router] = useState(() => createBrowserRouter(routes));
  return <RouterProvider router={router} />;
}

export function App() {
  return (
    <AuthGate>
      <AppRouter />
    </AuthGate>
  );
}
