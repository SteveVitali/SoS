import { useState } from "react";
import { Link, Route, Routes, useLocation } from "react-router-dom";
import { CreateJobForm } from "./components/CreateJobForm.js";
import { ChatDetail } from "./components/chat/ChatDetail.js";
import { ChatsList } from "./components/chat/ChatsList.js";
import { JobDetail } from "./components/jobs/JobDetail.js";
import { JobsList } from "./components/jobs/JobsList.js";
import { PrsList } from "./components/prs/PrsList.js";
import { RepoRegistryEditor } from "./components/registry/RepoRegistryEditor.js";
import { RoutingConfigEditor } from "./components/routing/RoutingConfigEditor.js";
import { NavTab } from "./components/shared/NavTab.js";
import { TokenSetup } from "./components/TokenSetup.js";
import { WorkerDetail } from "./components/workers/WorkerDetail.js";
import { WorkersList } from "./components/workers/WorkersList.js";
import { AppDataProvider } from "./stores/AppDataContext.js";
import { css } from "./styles/theme.js";

function AppShell() {
  const location = useLocation();
  const path = location.pathname;
  const isChatsTab = path === "/chats" || path.startsWith("/chats/");
  const showChatsList = path === "/chats";
  const showJobsList = path === "/";
  const showPrsList = path === "/prs";
  const isWorkersTab = path === "/workers" || path.startsWith("/workers/");
  const showWorkersList = path === "/workers";
  const isJobsTab = path === "/" || path.startsWith("/jobs");
  const isPrsTab = path === "/prs";
  const isReposTab = path === "/repos";
  const isRoutingTab = path === "/routing";

  return (
    <div style={css.container}>
      <div style={css.header}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Link to="/" style={{ textDecoration: "none" }}>
            <span style={css.title}>Son of Steve</span>
          </Link>
          <div style={{ display: "flex", gap: 0, marginLeft: 16 }}>
            <NavTab to="/chats" label="Chats" active={isChatsTab} />
            <NavTab to="/" label="Jobs" active={isJobsTab} />
            <NavTab to="/prs" label="PRs" active={isPrsTab} />
            <NavTab to="/workers" label="Workers" active={isWorkersTab} />
            <NavTab to="/repos" label="Repos" active={isReposTab} />
            <NavTab to="/routing" label="Routing" active={isRoutingTab} />
          </div>
        </div>
        <div style={css.nav}>
          <button
            type="button"
            style={css.btn}
            onClick={() => {
              localStorage.removeItem("sos_token");
              window.location.reload();
            }}
          >
            Logout
          </button>
        </div>
      </div>

      {/* Always-mounted list views — hidden when not active to preserve state */}
      <div style={{ display: showChatsList ? "block" : "none" }}>
        <ChatsList />
      </div>
      <div style={{ display: showJobsList ? "block" : "none" }}>
        <JobsList />
      </div>
      <div style={{ display: showPrsList ? "block" : "none" }}>
        <PrsList />
      </div>
      <div style={{ display: showWorkersList ? "block" : "none" }}>
        <WorkersList />
      </div>

      {/* Sub-pages rendered via Routes */}
      <Routes>
        <Route path="/workers/:id" element={<WorkerDetail />} />
        <Route path="/chats/:id" element={<ChatDetail />} />
        <Route path="/repos" element={<RepoRegistryEditor />} />
        <Route path="/routing" element={<RoutingConfigEditor />} />
        <Route path="/jobs/new" element={<CreateJobForm />} />
        <Route path="/jobs/:taskId" element={<JobDetail />} />
        <Route path="*" element={null} />
      </Routes>
    </div>
  );
}

export function App() {
  const [authed, setAuthed] = useState(() => !!localStorage.getItem("sos_token"));

  if (!authed) {
    return <TokenSetup onSet={() => setAuthed(true)} />;
  }

  return (
    <AppDataProvider>
      <AppShell />
    </AppDataProvider>
  );
}
