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
const StudySignoffPopup = lazy(() => import("./pages/StudySignoffPopup"));
const SharedStudy = lazy(() => import("./pages/SharedStudy"));
const NotFound = lazy(() => import("./pages/NotFound"));
const Messages = lazy(() => import("./pages/Messages"));
const VideoCalls = lazy(() => import("./pages/VideoCalls"));
const Cases = lazy(() => import("./pages/Cases"));
const CareDesk = lazy(() => import("./pages/CareDesk"));
const SoapNotes = lazy(() => import("./pages/SoapNotes"));
const Patients = lazy(() => import("./pages/Patients"));
const Clients = lazy(() => import("./pages/Clients"));
const AdminUsers = lazy(() => import("./pages/AdminUsers"));
const Submissions = lazy(() => import("./pages/Submissions"));
const AccountSettings = lazy(() => import("./pages/AccountSettings"));
const Login = lazy(() => import("./pages/Login"));
const Streams = lazy(() => import("./pages/Streams"));
const RevenueCalculator = lazy(() => import("./pages/RevenueCalculator"));
const WhiteLabelAdmin = lazy(() => import("./pages/WhiteLabelAdmin"));
const WhiteLabelSignup = lazy(() => import("./pages/WhiteLabelSignup"));
const TenantGovernance = lazy(() => import("./pages/TenantGovernance"));
const ReportTemplateWorkspace = lazy(() => import("./pages/ReportTemplateWorkspace"));

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
              <Route path="/white-label/signup/:token" element={<WhiteLabelSignup />} />
              <Route
                path="/white-label"
                element={
                  <AccessRoute roles={["admin", "doctor"]}>
                    <WhiteLabelAdmin />
                  </AccessRoute>
                }
              />
              <Route
                path="/studies/:id/sign"
                element={
                  <AccessRoute roles={["admin", "doctor", "clinic"]}>
                    <StudySignoffPopup />
                  </AccessRoute>
                }
              />
              <Route
                element={
                  <AccessRoute>
                    <AppLayout />
                  </AccessRoute>
                }
              >
                <Route
                  path="/streams"
                  element={
                    <AccessRoute roles={["admin", "doctor", "clinic"]}>
                      <Streams />
                    </AccessRoute>
                  }
                />
                <Route
                  path="/assigned-streams"
                  element={
                    <AccessRoute roles={["admin", "doctor", "clinic"]}>
                      <Streams assignedOnly />
                    </AccessRoute>
                  }
                />
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
                  path="/tenant-governance"
                  element={
                    <AccessRoute roles={["admin", "doctor", "clinic"]} features={["nextcloudReports", "governedDataExports"]}>
                      <TenantGovernance />
                    </AccessRoute>
                  }
                />
                <Route
                  path="/studies"
                  element={
                    <AccessRoute roles={["admin", "doctor", "clinic"]}>
                      <StudiesList />
                    </AccessRoute>
                  }
                />
                <Route
                  path="/studies/:id"
                  element={
                    <AccessRoute roles={["admin", "doctor", "clinic"]}>
                      <StudyDetail />
                    </AccessRoute>
                  }
                />
                <Route
                  path="/reports/new"
                  element={
                    <AccessRoute roles={["admin", "doctor", "clinic"]} features={["reportGeneration", "soapNotes"]}>
                      <ReportTemplateWorkspace />
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
                    <AccessRoute roles={["admin", "doctor"]} features={["patientPortal", "soapNotes", "nextcloudReports"]}>
                      <CareDesk />
                    </AccessRoute>
                  }
                />
                <Route
                  path="/soap-notes"
                  element={
                    <AccessRoute roles={["admin", "doctor", "clinic"]} features={["soapNotes"]}>
                      <SoapNotes />
                    </AccessRoute>
                  }
                />
                <Route
                  path="/revenue"
                  element={
                    <AccessRoute roles={["admin"]}>
                      <RevenueCalculator />
                    </AccessRoute>
                  }
                />
                <Route
                  path="/patients"
                  element={
                    <AccessRoute roles={["admin", "doctor", "clinic"]} features={["patientPortal"]}>
                      <Patients />
                    </AccessRoute>
                  }
                />
                <Route
                  path="/clients"
                  element={
                    <AccessRoute roles={["admin"]}>
                      <Clients />
                    </AccessRoute>
                  }
                />
                <Route
                  path="/submissions"
                  element={
                    <AccessRoute roles={["admin"]}>
                      <Submissions />
                    </AccessRoute>
                  }
                />
                <Route path="/messages" element={<Messages />} />
                <Route
                  path="/video"
                  element={
                    <AccessRoute features={["videoConsults"]}>
                      <VideoCalls />
                    </AccessRoute>
                  }
                />
                <Route path="/account" element={<AccountSettings />} />
                <Route
                  path="/cases"
                  element={
                    <AccessRoute roles={["admin", "patient"]} features={["patientPortal"]}>
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
