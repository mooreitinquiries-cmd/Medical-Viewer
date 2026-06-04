import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { lazy, Suspense } from "react";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/context/AuthContext";
import AccessRoute from "@/components/AccessRoute";
import AppLayout from "./components/AppLayout";

const queryClient = new QueryClient();
const Index = lazy(() => import("./pages/Index"));
const Dashboard = lazy(() => import("./pages/Dashboard"));
const UploadStudy = lazy(() => import("./pages/UploadStudy"));
const StudiesList = lazy(() => import("./pages/StudiesList"));
const StudyDetail = lazy(() => import("./pages/StudyDetail"));
const SharedStudy = lazy(() => import("./pages/SharedStudy"));
const NotFound = lazy(() => import("./pages/NotFound"));
const Messages = lazy(() => import("./pages/Messages"));
const VideoCalls = lazy(() => import("./pages/VideoCalls"));
const Cases = lazy(() => import("./pages/Cases"));
const CareDesk = lazy(() => import("./pages/CareDesk"));
const AdminUsers = lazy(() => import("./pages/AdminUsers"));
const AccountSettings = lazy(() => import("./pages/AccountSettings"));
const Login = lazy(() => import("./pages/Login"));
const Streams = lazy(() => import("./pages/Streams"));

function RouteFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">
      Loading...
    </div>
  );
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <AuthProvider>
        <Sonner />
        <BrowserRouter>
          <Suspense fallback={<RouteFallback />}>
            <Routes>
              <Route path="/" element={<Index />} />
              <Route path="/login" element={<Login />} />
              <Route path="/shared/:token" element={<SharedStudy />} />
              <Route element={<AppLayout />}>
                <Route path="/studies" element={<StudiesList />} />
                <Route path="/studies/:id" element={<StudyDetail />} />
                <Route path="/streams" element={<Streams />} />
              </Route>
              <Route
                element={
                  <AccessRoute>
                    <AppLayout />
                  </AccessRoute>
                }
              >
                <Route
                  path="/dashboard"
                  element={
                    <AccessRoute roles={["admin", "doctor", "clinic"]}>
                      <Dashboard />
                    </AccessRoute>
                  }
                />
                <Route
                  path="/admin/users"
                  element={
                    <AccessRoute roles={["admin"]}>
                      <AdminUsers />
                    </AccessRoute>
                  }
                />
                <Route
                  path="/upload"
                  element={
                    <AccessRoute roles={["admin", "doctor", "clinic"]}>
                      <UploadStudy />
                    </AccessRoute>
                  }
                />
                <Route
                  path="/care-desk"
                  element={
                    <AccessRoute roles={["admin", "doctor"]}>
                      <CareDesk />
                    </AccessRoute>
                  }
                />
                <Route path="/messages" element={<Messages />} />
                <Route path="/video" element={<VideoCalls />} />
                <Route path="/account" element={<AccountSettings />} />
                <Route
                  path="/cases"
                  element={
                    <AccessRoute roles={["admin", "patient"]}>
                      <Cases />
                    </AccessRoute>
                  }
                />
              </Route>
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
      </AuthProvider>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
