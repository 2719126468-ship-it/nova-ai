import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import Shell from './components/Shell';
import { AdminRoute, ProtectedRoute } from './components/ProtectedRoute';
import Home from './pages/Home';
import Products from './pages/Products';
import Research from './pages/Research';
import Article from './pages/Article';
import Auth from './pages/Auth';
import Chat from './pages/Chat';
import { Studio, StudioEditor } from './pages/Studio';
import Account from './pages/Account';
import Models from './pages/Models';
import Pricing from './pages/Pricing';
import Developers from './pages/Developers';
import Admin from './pages/Admin';
import About, { NotFound } from './pages/About';

export default function App() {
  return <BrowserRouter>
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
  </BrowserRouter>;
}
