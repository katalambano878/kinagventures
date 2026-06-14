'use client';

import Link from 'next/link';
import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

export default function AdminDashboard() {
  const [dateRange, setDateRange] = useState('7days'); // logic not implemented for this demo, just UI
  const [loading, setLoading] = useState(true);

  // Real Stats
  const [stats, setStats] = useState([
    {
      title: 'Total Revenue',
      value: 'GH₵ 0.00',
      change: '0%', // Placeholder trend
      trend: 'up',
      icon: 'ri-money-dollar-circle-line',
      color: 'gray'
    },
    {
      title: 'Orders',
      value: '0',
      change: '0%',
      trend: 'up',
      icon: 'ri-shopping-bag-line',
      color: 'blue'
    },
    {
      title: 'Customers', // This is total active users for us currently
      value: '0',
      change: '0%',
      trend: 'up',
      icon: 'ri-group-line',
      color: 'purple'
    },
    {
      title: 'Avg Order Value',
      value: 'GH₵ 0.00',
      change: '0%',
      trend: 'up',
      icon: 'ri-line-chart-line',
      color: 'amber'
    }
  ]);

  const [recentOrders, setRecentOrders] = useState<any[]>([]);
  const [lowStockProducts, setLowStockProducts] = useState<any[]>([]);
  const [topProducts, setTopProducts] = useState<any[]>([]);
  const [chartData, setChartData] = useState<any[]>([]);

  useEffect(() => {
    async function fetchDashboardData() {
      try {
        // 1. Fetch ALL Orders for count & customers
        const { data: allOrdersData, error: ordersError } = await supabase
          .from('orders')
          .select('total, status, payment_status, created_at, email');

        if (ordersError) throw ordersError;

        // Only count PAID orders for revenue & avg order value
        const paidOrders = allOrdersData?.filter(o => o.payment_status === 'paid') || [];
        const totalRevenue = paidOrders.reduce((sum, order) => sum + (order.total || 0), 0);
        const totalOrders = allOrdersData?.length || 0;
        const paidOrderCount = paidOrders.length;
        const avgOrderValue = paidOrderCount > 0 ? totalRevenue / paidOrderCount : 0;

        // 2. Fetch Customers Count (approximation using orders unique emails if we don't have user metrics access)
        // Since we can't query auth.users directly from client, we'll estimate active customers via orders or just keep it 0 if we can't.
        // Actually, best to just show "Orders" or "Recent Signups" if we had a public profiles table.
        // We'll use unique emails from orders as a proxy for "Customers"
        const uniqueCustomers = new Set(allOrdersData?.map(o => o.email)).size;


        // Process Chart Data (Last 7 Days) - only count PAID orders as revenue
        const last7Days = Array.from({ length: 7 }, (_, i) => {
          const d = new Date();
          d.setDate(d.getDate() - (6 - i));
          return d.toISOString().split('T')[0];
        });

        const chartMap = last7Days.reduce((acc: any, date) => {
          acc[date] = 0;
          return acc;
        }, {});

        paidOrders.forEach(order => {
          const date = new Date(order.created_at).toISOString().split('T')[0];
          if (chartMap[date] !== undefined) {
            chartMap[date] += (order.total || 0);
          }
        });

        const processedChartData = Object.keys(chartMap).map(date => ({
          date: new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
          revenue: chartMap[date]
        }));
        setChartData(processedChartData);

        setStats([
          {
            title: 'Total Revenue',
            value: `GH₵ ${totalRevenue.toFixed(2)}`,
            change: '+0%', // Dynamic change requires date filtering logic which is complex
            trend: 'up',
            icon: 'ri-money-dollar-circle-line',
            color: 'gray'
          },
          {
            title: 'Orders',
            value: totalOrders.toString(),
            change: '+0%',
            trend: 'up',
            icon: 'ri-shopping-bag-line',
            color: 'blue'
          },
          {
            title: 'Customers (Active)',
            value: uniqueCustomers.toString(), // Proxy
            change: '+0%',
            trend: 'up',
            icon: 'ri-group-line',
            color: 'purple'
          },
          {
            title: 'Avg Order Value',
            value: `GH₵ ${avgOrderValue.toFixed(2)}`,
            change: '+0%',
            trend: 'up',
            icon: 'ri-line-chart-line',
            color: 'amber'
          }
        ]);

        // 3. Fetch Recent Orders (only paid orders)
        const { data: recentOrdersData } = await supabase
          .from('orders')
          .select('id, order_number, user_id, email, created_at, total, status, shipping_address')
          .eq('payment_status', 'paid')
          .order('created_at', { ascending: false })
          .limit(5);

        if (recentOrdersData) {
          const formattedRecent = recentOrdersData.map((o: any) => {
            const addr = o.shipping_address || {};
            const customerName = (addr.firstName && addr.lastName)
              ? `${addr.firstName.trim()} ${addr.lastName.trim()}`
              : addr.full_name || addr.firstName || o.email.split('@')[0];
            return {
              id: o.id,
              displayId: o.order_number,
              customer: customerName,
              email: o.email,
              date: new Date(o.created_at).toLocaleDateString(),
              total: o.total,
              status: o.status,
              items: 1
            };
          });
          setRecentOrders(formattedRecent);
        }

        // 4. Fetch Low Stock Products
        const { data: lowStockData } = await supabase
          .from('products')
          .select('name, quantity')
          .lt('quantity', 10)
          .limit(5);

        if (lowStockData) {
          setLowStockProducts(lowStockData.map((p: any) => ({
            name: p.name,
            stock: p.quantity,
            status: p.quantity === 0 ? 'critical' : 'low'
          })));
        }

        // 5. Fetch Top Products (Approximation: High Price or just Random for now, 
        // real top selling requires aggregation on order_items which is complex for client-side)
        // real top selling requires aggregation on order_items which is complex for client-side)
        const { data: productData } = await supabase.from('products').select('*, product_images(url)').limit(4);
        if (productData) {
          setTopProducts(productData.map((p: any) => ({
            id: p.slug, // Use slug for link
            name: p.name,
            image: p.product_images?.[0]?.url || 'https://via.placeholder.com/200',
            sales: 0, // Mocked for now
            revenue: 0, // Mocked for now
            stock: p.quantity
          })));
        }

      } catch (error) {
        console.error('Error loading dashboard:', error);
      } finally {
        setLoading(false);
      }
    }

    fetchDashboardData();
  }, []);

  const statusColors: any = {
    'pending': 'bg-amber-100 text-amber-700',
    'processing': 'bg-blue-100 text-blue-700',
    'shipped': 'bg-purple-100 text-purple-700',
    'delivered': 'bg-gray-100 text-gray-900',
    'cancelled': 'bg-red-100 text-red-700'
  };

  const quickActions = [
    {
      title: 'Feature Modules',
      description: 'Manage 40+ store features',
      icon: 'ri-puzzle-line',
      color: 'purple',
      link: '/admin/modules',
      badge: '40 Features'
    },
    {
      title: 'Inventory Management',
      description: 'Track stock & manage reorders',
      icon: 'ri-stack-line',
      color: 'amber',
      link: '/admin/inventory'
    },
    // ... reduced list for brevity or keep all if desired
  ];

  if (loading) {
    return <div className="p-8 text-center text-gray-500">Loading Dashboard...</div>;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Dashboard</h1>
            <p className="text-gray-600 mt-1">Welcome back! Here's what's happening with your store.</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
          {stats.map((stat) => (
            <div key={stat.title} className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 hover:shadow-md transition-shadow">
              <div className="flex items-center justify-between mb-4">
                <div className={`w-12 h-12 flex items-center justify-center bg-${stat.color}-100 text-${stat.color}-700 rounded-lg`}>
                  <i className={`${stat.icon} text-2xl`}></i>
                </div>
                <span className={`text-sm font-semibold text-gray-900`}>
                  {stat.change}
                </span>
              </div>
              <h3 className="text-2xl font-bold text-gray-900 mb-1">{stat.value}</h3>
              <p className="text-gray-600 text-sm">{stat.title}</p>
            </div>
          ))}
        </div>

        {/* Revenue Chart & Quick Actions */}
        <div className="grid lg:grid-cols-3 gap-6 mb-8">
          <div className="lg:col-span-2 bg-white p-6 rounded-xl shadow-sm border border-gray-200">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-bold text-gray-900">Revenue Trend</h2>
              <select
                className="bg-gray-50 border border-gray-200 text-gray-700 text-sm rounded-lg focus:ring-gray-600 focus:border-gray-600 block p-2"
                value={dateRange}
                onChange={(e) => setDateRange(e.target.value)}
              >
                <option value="7days">Last 7 Days</option>
                <option value="30days">Last 30 Days</option>
              </select>
            </div>
            <div className="h-80 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorRevenue" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#374151" stopOpacity={0.1} />
                      <stop offset="95%" stopColor="#374151" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                  <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: '#64748b' }} dy={10} />
                  <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: '#64748b' }} tickFormatter={(value) => `GH₵${value}`} />
                  <Tooltip
                    contentStyle={{ backgroundColor: '#fff', borderRadius: '8px', border: '1px solid #e2e8f0', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                    formatter={(value) => [`GH₵${(value as number)?.toFixed(2) ?? '0.00'}`, 'Revenue']}
                  />
                  <Area type="monotone" dataKey="revenue" stroke="#374151" strokeWidth={3} fillOpacity={1} fill="url(#colorRevenue)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
            <h2 className="text-xl font-bold text-gray-900 mb-4">Quick Actions</h2>
            <div className="space-y-3">
              <Link href="/admin/products/new" className="flex items-center justify-between p-4 bg-gray-50 hover:bg-gray-50 text-gray-700 hover:text-gray-900 rounded-lg transition-colors group">
                <div className="flex items-center font-medium">
                  <span className="w-8 h-8 rounded-full bg-white flex items-center justify-center mr-3 group-hover:bg-gray-100 transition-colors shadow-sm">
                    <i className="ri-add-line"></i>
                  </span>
                  Add Product
                </div>
                <i className="ri-arrow-right-line"></i>
              </Link>
              {/* <Link href="/admin/pos" className="flex items-center justify-between p-4 bg-gray-50 hover:bg-gray-50 text-gray-700 hover:text-gray-900 rounded-lg transition-colors group">
                <div className="flex items-center font-medium">
                  <span className="w-8 h-8 rounded-full bg-white flex items-center justify-center mr-3 group-hover:bg-gray-100 transition-colors shadow-sm">
                    <i className="ri-computer-line"></i>
                  </span>
                  Open POS
                </div>
                <i className="ri-arrow-right-line"></i>
              </Link> */}
              <Link href="/admin/orders" className="flex items-center justify-between p-4 bg-gray-50 hover:bg-gray-50 text-gray-700 hover:text-gray-900 rounded-lg transition-colors group">
                <div className="flex items-center font-medium">
                  <span className="w-8 h-8 rounded-full bg-white flex items-center justify-center mr-3 group-hover:bg-gray-100 transition-colors shadow-sm">
                    <i className="ri-file-list-line"></i>
                  </span>
                  Manage Orders
                </div>
                <i className="ri-arrow-right-line"></i>
              </Link>
            </div>
          </div>
        </div>

        <div className="grid lg:grid-cols-3 gap-6 mb-8">
          <div className="lg:col-span-2 bg-white rounded-xl shadow-sm border border-gray-200 p-4 sm:p-6 overflow-hidden">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl font-bold text-gray-900">Recent Orders</h2>
              <Link href="/admin/orders" className="text-gray-900 hover:text-gray-800 font-medium text-sm whitespace-nowrap cursor-pointer">
                View All <i className="ri-arrow-right-line ml-1"></i>
              </Link>
            </div>

            <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
              {recentOrders.length === 0 ? (
                <p className="text-gray-500 text-center py-4">No recent orders.</p>
              ) : (
                <table className="w-full">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">Order ID</th>
                      <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">Customer</th>
                      <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">Date</th>
                      <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">Total</th>
                      <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentOrders.map((order) => (
                      <tr key={order.id} className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
                        <td className="py-4 px-4">
                          <Link href={`/admin/orders/${order.id}`} className="text-gray-900 hover:text-gray-800 font-medium whitespace-nowrap cursor-pointer">
                            {order.displayId}
                          </Link>
                        </td>
                        <td className="py-4 px-4">
                          <p className="font-medium text-gray-900 whitespace-nowrap">{order.customer}</p>
                          <p className="text-sm text-gray-500">{order.email}</p>
                        </td>
                        <td className="py-4 px-4 text-gray-700 whitespace-nowrap">{order.date}</td>
                        <td className="py-4 px-4 font-semibold text-gray-900 whitespace-nowrap">GH₵ {order.total.toFixed(2)}</td>
                        <td className="py-4 px-4">
                          <span className={`px-3 py-1 rounded-full text-xs font-semibold whitespace-nowrap ${statusColors[order.status] || 'bg-gray-100'}`}>
                            {order.status === 'shipped' ? 'Packaged' : order.status.charAt(0).toUpperCase() + order.status.slice(1)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          <div className="space-y-6">
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
              <h2 className="text-xl font-bold text-gray-900 mb-4">Low Stock Alert</h2>
              {lowStockProducts.length === 0 ? (
                <p className="text-gray-500">Inventory looks good!</p>
              ) : (
                <div className="space-y-3">
                  {lowStockProducts.map((product, index) => (
                    <div key={index} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                      <div className="flex-1">
                        <p className="font-medium text-gray-900 text-sm truncate pr-2">{product.name}</p>
                        <p className="text-xs text-gray-600 mt-1">Stock: {product.stock} units</p>
                      </div>
                      <span className={`px-2 py-1 rounded-full text-xs font-semibold whitespace-nowrap ${product.status === 'critical' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'
                        }`}>
                        {product.status === 'critical' ? 'Critical' : 'Low'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <Link href="/admin/products?filter=low-stock" className="block text-center mt-4 text-gray-900 hover:text-gray-800 font-medium text-sm whitespace-nowrap cursor-pointer">
                View All Products <i className="ri-arrow-right-line ml-1"></i>
              </Link>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4 sm:p-6 overflow-hidden">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-bold text-gray-900">Products</h2>
            <Link href="/admin/products" className="text-gray-900 hover:text-gray-800 font-medium text-sm whitespace-nowrap cursor-pointer">
              View All <i className="ri-arrow-right-line ml-1"></i>
            </Link>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
            {topProducts.map((product) => (
              <div key={product.id} className="border border-gray-200 rounded-xl p-4 hover:shadow-md transition-shadow">
                <div className="aspect-square bg-gray-100 rounded-lg overflow-hidden mb-3">
                  <img src={product.image} alt={product.name} className="w-full h-full object-cover" />
                </div>
                <h3 className="font-semibold text-gray-900 mb-2 line-clamp-2">{product.name}</h3>
                <div className="mt-3 pt-3 border-t border-gray-200 flex items-center justify-between">
                  <span className="text-sm text-gray-600">Stock: {product.stock}</span>
                  <Link href={`/admin/products/${product.id}`} className="text-gray-900 hover:text-gray-800 text-sm font-medium whitespace-nowrap cursor-pointer">
                    Edit <i className="ri-arrow-right-line ml-1"></i>
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
