'use client';

import Link from 'next/link';
import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import ProductSalesStats from './ProductSalesStats';

interface Order {
  id: string;
  order_number: string;
  email: string;
  total: number;
  status: string;
  payment_status: string;
  payment_method: string;
  shipping_method: string;
  created_at: string;
  phone?: string;
  shipping_address?: any;
  metadata?: any;
  profiles?: {
    full_name: string;
    email: string;
  };
  order_items?: {
    quantity: number;
    product_name?: string;
  }[];
}

interface OrderStats {
  label: string;
  count: number;
  status: string;
}

export default function AdminOrdersPage() {
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [selectedOrders, setSelectedOrders] = useState<string[]>([]);
  const [showFilters, setShowFilters] = useState(false);
  const [sortBy, setSortBy] = useState('date');
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [orderViewTab, setOrderViewTab] = useState<'confirmed' | 'abandoned'>('confirmed');
  const [sendingPaymentLink, setSendingPaymentLink] = useState<string | null>(null);
  const [orderStats, setOrderStats] = useState<OrderStats[]>([
    { label: 'All Orders', count: 0, status: 'all' },
    { label: 'Pending', count: 0, status: 'pending' },
    { label: 'Processing', count: 0, status: 'processing' },
    { label: 'Packaged', count: 0, status: 'shipped' },
    { label: 'Delivered', count: 0, status: 'delivered' },
    { label: 'Cancelled', count: 0, status: 'cancelled' }
  ]);
  const [abandonedCount, setAbandonedCount] = useState(0);
  const [confirmedCount, setConfirmedCount] = useState(0);
  const [showProductStats, setShowProductStats] = useState(false);
  const [productFilter, setProductFilter] = useState('all');
  const [availableProducts, setAvailableProducts] = useState<string[]>([]);

  useEffect(() => {
    fetchOrders();
  }, []);

  const fetchOrders = async () => {
    try {
      setLoading(true);

      // Fetch orders with related data
      const { data: ordersData, error } = await supabase
        .from('orders')
        .select(`
          id,
          order_number,
          email,
          total,
          status,
          payment_status,
          payment_method,
          shipping_method,
          created_at,
          phone,
          shipping_address,
          metadata,
          order_items (
            quantity,
            product_name
          )
        `)
        .order('created_at', { ascending: false });

      if (error) throw error;

      setOrders(ordersData || []);

      // Extract unique product names for filter
      const productNames = new Set<string>();
      ordersData?.forEach(o => {
        o.order_items?.forEach((item: any) => {
          if (item.product_name) productNames.add(item.product_name);
        });
      });
      setAvailableProducts(Array.from(productNames).sort());

      // Separate confirmed (paid or deposit-paid) from abandoned (pending payment).
      // A partially_paid order has a real deposit, so it counts as confirmed.
      const isConfirmedPayment = (s: string) => s === 'paid' || s === 'partially_paid';
      const confirmedOrders = ordersData?.filter(o => isConfirmedPayment(o.payment_status)) || [];
      const abandonedOrders = ordersData?.filter(o => !isConfirmedPayment(o.payment_status)) || [];
      
      setConfirmedCount(confirmedOrders.length);
      setAbandonedCount(abandonedOrders.length);

      // Calculate stats based on confirmed orders only
      const stats = [
        { label: 'All Orders', count: confirmedOrders.length, status: 'all' },
        { label: 'Pending', count: confirmedOrders.filter(o => o.status === 'pending').length, status: 'pending' },
        { label: 'Processing', count: confirmedOrders.filter(o => o.status === 'processing').length, status: 'processing' },
        { label: 'Packaged', count: confirmedOrders.filter(o => o.status === 'shipped').length, status: 'shipped' },
        { label: 'Delivered', count: confirmedOrders.filter(o => o.status === 'delivered').length, status: 'delivered' },
        { label: 'Cancelled', count: confirmedOrders.filter(o => o.status === 'cancelled').length, status: 'cancelled' }
      ];
      setOrderStats(stats);

    } catch (error) {
      console.error('Error fetching orders:', error);
    } finally {
      setLoading(false);
    }
  };

  const statusColors: Record<string, string> = {
    'pending': 'bg-amber-100 text-amber-700 border-amber-200',
    'processing': 'bg-blue-100 text-blue-700 border-blue-200',
    'shipped': 'bg-purple-100 text-purple-700 border-purple-200',
    'delivered': 'bg-gray-100 text-gray-900 border-gray-200',
    'cancelled': 'bg-red-100 text-red-700 border-red-200',
    'awaiting_payment': 'bg-gray-100 text-gray-700 border-gray-200'
  };

  const formatStatus = (status: string) => {
    if (status === 'shipped') return 'Packaged';
    return status ? status.charAt(0).toUpperCase() + status.slice(1) : 'Unknown';
  };

  const getCustomerName = (order: Order) => {
    // Try shipping address names first (most reliable — entered at checkout)
    if (order.shipping_address?.firstName || order.shipping_address?.lastName) {
      const first = order.shipping_address.firstName?.trim() || '';
      const last = order.shipping_address.lastName?.trim() || '';
      return `${first} ${last}`.trim();
    }
    if (order.shipping_address?.full_name) return order.shipping_address.full_name;
    // Try metadata names
    if (order.metadata?.first_name || order.metadata?.last_name) {
      const first = order.metadata.first_name?.trim() || '';
      const last = order.metadata.last_name?.trim() || '';
      return `${first} ${last}`.trim();
    }
    if (order.profiles?.full_name) return order.profiles.full_name;
    if (order.email) {
      const name = order.email.split('@')[0];
      return name.charAt(0).toUpperCase() + name.slice(1);
    }
    return 'Guest';
  };

  const getCustomerEmail = (order: Order) => {
    return order.email || order.profiles?.email || 'N/A';
  };

  const getCustomerAvatar = (order: Order) => {
    const name = getCustomerName(order);
    const parts = name.split(' ');
    if (parts.length >= 2) {
      return parts[0][0] + parts[1][0];
    }
    return name.substring(0, 2).toUpperCase();
  };

  const getItemCount = (order: Order) => {
    if (!order.order_items) return 0;
    return order.order_items.reduce((sum, item) => sum + item.quantity, 0);
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  };

  const handleSelectAll = () => {
    if (selectedOrders.length === filteredOrders.length) {
      setSelectedOrders([]);
    } else {
      setSelectedOrders(filteredOrders.map(o => o.id));
    }
  };

  const handleSelectOrder = (orderId: string) => {
    if (selectedOrders.includes(orderId)) {
      setSelectedOrders(selectedOrders.filter(id => id !== orderId));
    } else {
      setSelectedOrders([...selectedOrders, orderId]);
    }
  };

  const handleBulkAction = async (action: string, newStatus?: string) => {
    if (newStatus) {
      try {
        const { error } = await supabase
          .from('orders')
          .update({ status: newStatus })
          .in('id', selectedOrders);

        if (error) throw error;



        // Send Notifications with auth token
        const { data: { session } } = await supabase.auth.getSession();
        const authToken = session?.access_token;
        
        const updatedOrders = orders.filter(o => selectedOrders.includes(o.id));
        updatedOrders.forEach(order => {
          fetch('/api/notifications', {
            method: 'POST',
            headers: { 
              'Content-Type': 'application/json',
              ...(authToken && { 'Authorization': `Bearer ${authToken}` })
            },
            body: JSON.stringify({
              type: 'order_updated',
              payload: { order, status: newStatus }
            })
          }).catch(err => console.error('Notification error', err));
        });

        await fetchOrders();
        setSelectedOrders([]);
        alert(`${selectedOrders.length} orders updated to ${newStatus}`);
      } catch (error) {
        console.error('Error updating orders:', error);
        alert('Failed to update orders');
      }
    } else if (action === 'Export') {
      const ordersToExport = orders.filter(o => selectedOrders.includes(o.id));
      const csvContent = `Order ID,Customer,Email,Date,Items,Total,Status,Payment\n${ordersToExport.map(o =>
        `${o.order_number || o.id},${getCustomerName(o)},${getCustomerEmail(o)},${formatDate(o.created_at)},${getItemCount(o)},${o.total},${o.status},${o.payment_method || 'N/A'}`
      ).join('\n')}`;
      const blob = new Blob([csvContent], { type: 'text/csv' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'selected-orders.csv';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    }
  };

  const handleExportAll = () => {
    const csvContent = `Order ID,Customer,Email,Date,Items,Total,Status,Payment\n${orders.map(o =>
      `${o.order_number || o.id},${getCustomerName(o)},${getCustomerEmail(o)},${formatDate(o.created_at)},${getItemCount(o)},${o.total},${o.status},${o.payment_method || 'N/A'}`
    ).join('\n')}`;
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'all-orders.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  };

  const handlePrintInvoice = (orderId: string) => {
    window.open(`/admin/orders/${orderId}?print=true`, '_blank');
  };

  const handleResendPaymentLink = async (order: Order) => {
    setSendingPaymentLink(order.id);
    try {
      const response = await fetch('/api/notifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'payment_link',
          payload: order
        })
      });
      
      if (!response.ok) throw new Error('Failed to send');
      
      alert(`Payment link sent to ${order.phone || order.email}`);
    } catch (error) {
      console.error('Error sending payment link:', error);
      alert('Failed to send payment link');
    } finally {
      setSendingPaymentLink(null);
    }
  };

  const filteredOrders = orders.filter(order => {
    const customerName = getCustomerName(order).toLowerCase();
    const customerEmail = getCustomerEmail(order).toLowerCase();
    const orderId = (order.order_number || order.id).toLowerCase();

    // First filter by view tab (confirmed vs abandoned)
    const isConfirmed = order.payment_status === 'paid' || order.payment_status === 'partially_paid';
    const matchesViewTab = orderViewTab === 'confirmed' ? isConfirmed : !isConfirmed;

    const matchesSearch = orderId.includes(searchQuery.toLowerCase()) ||
      customerName.includes(searchQuery.toLowerCase()) ||
      customerEmail.includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === 'all' || order.status === statusFilter;
    const matchesProduct = productFilter === 'all' || 
      order.order_items?.some((item: any) => item.product_name === productFilter);
    return matchesViewTab && matchesSearch && matchesStatus && matchesProduct;
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Orders</h1>
          <p className="text-gray-600 mt-1">Manage and track all customer orders</p>
        </div>
        <div className="flex items-center gap-3 w-full md:w-auto">
          <button
            onClick={() => setShowProductStats(true)}
            className="flex-1 md:flex-none bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 px-6 py-3 rounded-lg font-semibold transition-colors whitespace-nowrap cursor-pointer shadow-sm flex items-center justify-center"
          >
            <i className="ri-bar-chart-groupped-line mr-2"></i>
            Stats
          </button>
          <button
            onClick={handleExportAll}
            className="flex-1 md:flex-none bg-primary hover:bg-primary text-white px-6 py-3 rounded-lg font-semibold transition-colors whitespace-nowrap cursor-pointer shadow-sm flex items-center justify-center"
          >
            <i className="ri-download-line mr-2"></i>
            Export
          </button>
        </div>
      </div>

      {/* View Tabs: Confirmed Orders vs Abandoned Carts */}
      <div className="flex border-b border-gray-200">
        <button
          onClick={() => { setOrderViewTab('confirmed'); setStatusFilter('all'); }}
          className={`px-6 py-3 font-semibold text-sm border-b-2 transition-colors cursor-pointer ${
            orderViewTab === 'confirmed'
              ? 'border-gray-900 text-gray-900'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          <i className="ri-check-double-line mr-2"></i>
          Confirmed Orders ({confirmedCount})
        </button>
        <button
          onClick={() => { setOrderViewTab('abandoned'); setStatusFilter('all'); }}
          className={`relative px-6 py-3 font-semibold text-sm border-b-2 transition-colors cursor-pointer flex items-center ${
            orderViewTab === 'abandoned'
              ? 'border-amber-600 text-amber-600'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          <i className="ri-shopping-cart-2-line mr-2"></i>
          <span>Abandoned Carts</span>
          <span className={`ml-2 inline-flex items-center justify-center min-w-[1.5rem] h-6 px-2 rounded-full text-xs font-bold ${
            abandonedCount > 0
              ? 'bg-amber-500 text-white'
              : 'bg-gray-100 text-gray-500'
          }`}>
            {abandonedCount}
          </span>
          {abandonedCount > 0 && orderViewTab !== 'abandoned' && (
            <span className="absolute -top-0.5 right-2 flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-500"></span>
            </span>
          )}
        </button>
      </div>

      {orderViewTab === 'confirmed' && (
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        {orderStats.map((stat) => (
          <button
            key={stat.status}
            onClick={() => setStatusFilter(stat.status)}
            className={`p-4 rounded-xl border-2 transition-all text-left cursor-pointer ${statusFilter === stat.status
              ? 'border-gray-900 bg-gray-50'
              : 'border-gray-200 bg-white hover:border-gray-300'
              }`}
          >
            <p className="text-2xl font-bold text-gray-900">{stat.count}</p>
            <p className="text-sm text-gray-600 mt-1">{stat.label}</p>
          </button>
        ))}
      </div>
      )}

      {/* Abandoned carts info banner */}
      {orderViewTab === 'abandoned' && abandonedCount > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
          <div className="flex items-start space-x-3">
            <i className="ri-information-line text-xl text-amber-600 mt-0.5"></i>
            <div>
              <p className="text-sm font-semibold text-amber-800">Abandoned Carts</p>
              <p className="text-sm text-amber-700 mt-1">
                These orders were created but payment was not completed. You can resend payment links to customers.
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        <div className="p-6 border-b border-gray-200">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between space-y-4 md:space-y-0">
            <div className="flex-1 max-w-md">
              <div className="relative">
                <i className="ri-search-line absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 text-lg w-5 h-5 flex items-center justify-center"></i>
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search by order ID, customer name, or email..."
                  className="w-full pl-12 pr-4 py-3 border-2 border-gray-300 rounded-lg focus:ring-2 focus:ring-gray-600 focus:border-gray-600 text-sm"
                />
              </div>
            </div>

            <div className="flex items-center space-x-3">
              <button
                onClick={() => setShowFilters(!showFilters)}
                className="px-4 py-3 border-2 border-gray-300 text-gray-700 rounded-lg hover:border-gray-400 transition-colors font-medium whitespace-nowrap cursor-pointer"
              >
                <i className="ri-filter-line mr-2"></i>
                Filters
              </button>
              <select
                value={productFilter}
                onChange={(e) => setProductFilter(e.target.value)}
                className="px-4 py-3 pr-8 border-2 border-gray-300 rounded-lg focus:ring-2 focus:ring-gray-600 focus:border-gray-600 font-medium cursor-pointer"
              >
                <option value="all">All Products</option>
                {availableProducts.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
                className="px-4 py-3 pr-8 border-2 border-gray-300 rounded-lg focus:ring-2 focus:ring-gray-600 focus:border-gray-600 font-medium cursor-pointer"
              >
                <option value="date">Sort by Date</option>
                <option value="total">Sort by Total</option>
                <option value="customer">Sort by Customer</option>
                <option value="status">Sort by Status</option>
              </select>
            </div>
          </div>

          {showFilters && (
            <div className="mt-4 p-4 bg-gray-50 rounded-lg grid md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">Date Range</label>
                <input type="date" className="w-full px-3 py-2 border-2 border-gray-300 rounded-lg text-sm" />
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">Payment Method</label>
                <select className="w-full px-3 py-2 pr-8 border-2 border-gray-300 rounded-lg text-sm cursor-pointer">
                  <option>All Methods</option>
                  <option>Moolre</option>
                  <option>Mobile Money</option>
                  <option>Card</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">Shipping Method</label>
                <select className="w-full px-3 py-2 pr-8 border-2 border-gray-300 rounded-lg text-sm cursor-pointer">
                  <option>All Methods</option>
                  <option>Standard</option>
                  <option>Express</option>
                  <option>Store Pickup</option>
                </select>
              </div>
            </div>
          )}
        </div>

        {selectedOrders.length > 0 && (
          <div className="p-4 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
            <p className="text-gray-800 font-semibold">
              {selectedOrders.length} order{selectedOrders.length > 1 ? 's' : ''} selected
            </p>
            <div className="flex items-center space-x-2">
              <button
                onClick={() => handleBulkAction('Mark as Processing', 'processing')}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors whitespace-nowrap cursor-pointer"
              >
                Mark Processing
              </button>
              <button
                onClick={() => handleBulkAction('Mark as Packaged', 'shipped')}
                className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg text-sm font-medium transition-colors whitespace-nowrap cursor-pointer"
              >
                Mark Packaged
              </button>
              <button
                onClick={() => handleBulkAction('Export')}
                className="px-4 py-2 bg-gray-700 hover:bg-primary text-white rounded-lg text-sm font-medium transition-colors whitespace-nowrap cursor-pointer"
              >
                <i className="ri-download-line mr-2"></i>
                Export
              </button>
            </div>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="py-4 px-6">
                  <input
                    type="checkbox"
                    checked={selectedOrders.length === filteredOrders.length && filteredOrders.length > 0}
                    onChange={handleSelectAll}
                    className="w-4 h-4 text-gray-900 border-gray-300 rounded focus:ring-gray-600 cursor-pointer"
                  />
                </th>
                <th className="text-left py-4 px-4 text-sm font-semibold text-gray-700">Order ID</th>
                <th className="text-left py-4 px-4 text-sm font-semibold text-gray-700">Customer</th>
                <th className="text-left py-4 px-4 text-sm font-semibold text-gray-700">Date</th>
                <th className="text-left py-4 px-4 text-sm font-semibold text-gray-700">Items</th>
                <th className="text-left py-4 px-4 text-sm font-semibold text-gray-700">Total</th>
                <th className="text-left py-4 px-4 text-sm font-semibold text-gray-700">Payment</th>
                <th className="text-left py-4 px-4 text-sm font-semibold text-gray-700">Status</th>
                <th className="text-left py-4 px-4 text-sm font-semibold text-gray-700">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={9} className="py-12 text-center text-gray-500">
                    <i className="ri-loader-4-line animate-spin text-3xl text-gray-900"></i>
                    <p className="mt-2">Loading orders...</p>
                  </td>
                </tr>
              ) : filteredOrders.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-12 text-center text-gray-500">
                    <i className="ri-inbox-line text-4xl text-gray-300"></i>
                    <p className="mt-2">No orders found</p>
                    <p className="text-sm">Orders will appear here when customers place them</p>
                  </td>
                </tr>
              ) : (
                filteredOrders.map((order) => (
                  <tr key={order.id} className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
                    <td className="py-4 px-6">
                      <input
                        type="checkbox"
                        checked={selectedOrders.includes(order.id)}
                        onChange={() => handleSelectOrder(order.id)}
                        className="w-4 h-4 text-gray-900 border-gray-300 rounded focus:ring-gray-600 cursor-pointer"
                      />
                    </td>
                    <td className="py-4 px-4">
                      <Link href={`/admin/orders/${order.id}`} className="text-gray-900 hover:text-gray-800 font-semibold whitespace-nowrap cursor-pointer">
                        {order.order_number || order.id.substring(0, 8)}
                      </Link>
                    </td>
                    <td className="py-4 px-4">
                      <div className="flex items-center space-x-3">
                        <div className="w-10 h-10 flex items-center justify-center bg-gray-200 text-gray-700 rounded-full font-semibold text-sm">
                          {getCustomerAvatar(order)}
                        </div>
                        <div>
                          <p className="font-medium text-gray-900 whitespace-nowrap">{getCustomerName(order)}</p>
                          <p className="text-sm text-gray-500">{getCustomerEmail(order)}</p>
                        </div>
                      </div>
                    </td>
                    <td className="py-4 px-4 text-gray-700 text-sm whitespace-nowrap">{formatDate(order.created_at)}</td>
                    <td className="py-4 px-4 text-gray-700">{getItemCount(order)}</td>
                    <td className="py-4 px-4 font-semibold text-gray-900 whitespace-nowrap">GH₵ {order.total?.toFixed(2) || '0.00'}</td>
                    <td className="py-4 px-4 text-sm whitespace-nowrap">
                      <div className="flex flex-col">
                        <span className="text-gray-700">{order.payment_method || 'N/A'}</span>
                        {orderViewTab === 'abandoned' && (
                          <span className={`text-xs mt-1 ${order.payment_status === 'failed' ? 'text-red-600' : 'text-amber-600'}`}>
                            {order.payment_status === 'failed' ? 'Failed' : 'Pending'}
                          </span>
                        )}
                        {order.payment_status === 'partially_paid' && (
                          <span className="text-xs mt-1 inline-flex items-center gap-1 text-orange-700 font-semibold">
                            <i className="ri-wallet-3-line"></i>
                            Deposit · Bal GH₵ {(Number(order.metadata?.balance_due) || Number(order.total) / 2).toFixed(2)}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="py-4 px-4">
                      <span className={`px-3 py-1 rounded-full text-xs font-semibold border whitespace-nowrap ${statusColors[order.status] || 'bg-gray-100 text-gray-700 border-gray-200'}`}>
                        {formatStatus(order.status)}
                      </span>
                    </td>
                    <td className="py-4 px-4">
                      <div className="flex items-center space-x-2">
                        <Link
                          href={`/admin/orders/${order.id}`}
                          className="w-8 h-8 flex items-center justify-center text-gray-600 hover:text-gray-900 hover:bg-gray-50 rounded-lg transition-colors cursor-pointer"
                          title="View Order"
                        >
                          <i className="ri-eye-line text-lg w-4 h-4 flex items-center justify-center"></i>
                        </Link>
                        {orderViewTab === 'abandoned' && order.payment_status !== 'paid' && (
                          <button
                            onClick={() => handleResendPaymentLink(order)}
                            disabled={sendingPaymentLink === order.id}
                            className="w-8 h-8 flex items-center justify-center text-amber-600 hover:text-amber-800 hover:bg-amber-50 rounded-lg transition-colors cursor-pointer disabled:opacity-50"
                            title="Resend Payment Link"
                          >
                            {sendingPaymentLink === order.id ? (
                              <i className="ri-loader-4-line text-lg w-4 h-4 flex items-center justify-center animate-spin"></i>
                            ) : (
                              <i className="ri-send-plane-line text-lg w-4 h-4 flex items-center justify-center"></i>
                            )}
                          </button>
                        )}
                        <button
                          onClick={() => handlePrintInvoice(order.id)}
                          className="w-8 h-8 flex items-center justify-center text-gray-600 hover:text-blue-700 hover:bg-blue-50 rounded-lg transition-colors cursor-pointer"
                          title="Print Invoice"
                        >
                          <i className="ri-printer-line text-lg w-4 h-4 flex items-center justify-center"></i>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {filteredOrders.length > 0 && (
          <div className="p-6 border-t border-gray-200 flex items-center justify-between">
            <p className="text-gray-600">Showing {filteredOrders.length} of {orders.length} orders</p>
          </div>
        )}
      </div>

      <ProductSalesStats isOpen={showProductStats} onClose={() => setShowProductStats(false)} />
    </div>
  );
}
