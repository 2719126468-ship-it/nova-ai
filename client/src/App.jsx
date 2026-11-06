import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import Shell from './components/Shell';
import { AdminRoute, ProtectedRoute } from './components/ProtectedRoute';

const Home = lazy(() => import('./pages/Home'));
const Products = lazy(() => import('./pages/Products'));
const Research = lazy(() => import('./pages/Research'));
const Article = lazy(() => import('./pages/Article'));
const Auth = lazy(() => import('./pages/Auth'));
const Chat = lazy(() => import('./pages/Chat'));
const Studio = lazy(() => import('./pages/Studio').then((module) => ({ default: module.Studio })));
const StudioEditor = lazy(() => import('./pages/Studio').then((module) => ({ default: module.StudioEditor })));
const Account = lazy(() => import('./pages/Account'));
const Models = lazy(() => import('./pages/Models'));
const Pricing = lazy(() => import('./pages/Pricing'));
const Developers = lazy(() => import('./pages/Developers'));
const Admin = lazy(() => import('./pages/Admin'));
const About = lazy(() => import('./pages/About'));
const NotFound = lazy(() => import('./pages/About').then((module) => ({ default: module.NotFound })));

function RouteLoading() {
  return <div className="route-loading" role="status" aria-live="polite">正在加载页面…</div>;
}

export default function App() {
  return <BrowserRouter>
    <Suspense fallback={<RouteLoading />}>
      <Routes>
        <Route element={<Shell />}>
          <Route index element={<Home />} />
          <Route path="products" element={<Products />} />
          <Route path="research" element={<Research />} />
          <Route path="research/:slug" element={<Article />} />
          <Route path="models" element={<Models />} />
          <Route path="pricing" element={<Pricing />} />
          <Route path="developers" element={<Developers />} />
          <Route path="about" element={<About />} />
          <Route path="login" element={<Auth />} />
          <Route path="register" element={<Auth />} />
          <Route element={<ProtectedRoute />}>
            <Route path="chat" element={<Chat />} />
            <Route path="studio" element={<Studio />} />
            <Route path="studio/:id" element={<StudioEditor />} />
            <Route path="account" element={<Account />} />
          </Route>
          <Route element={<AdminRoute />}>
            <Route path="admin" element={<Admin />} />
          </Route>
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </Suspense>
  </BrowserRouter>;
}
