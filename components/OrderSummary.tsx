interface OrderItem {
  id: string;
  name: string;
  price: number;
  quantity: number;
  image: string;
  variant?: string;
}

interface OrderSummaryProps {
  items: OrderItem[];
  subtotal: number;
  shipping: number;
  tax: number;
  total: number;
  paymentPlan?: 'full' | 'deposit_50' | 'partial';
  depositAmount?: number;
  balanceDue?: number;
}

export default function OrderSummary({ items, subtotal, shipping, tax, total, paymentPlan = 'full', depositAmount = 0, balanceDue = 0 }: OrderSummaryProps) {
  const isDeposit = paymentPlan === 'deposit_50' || paymentPlan === 'partial';
  return (
    <div className="bg-white rounded-xl shadow-sm p-6 sticky top-4">
      <h2 className="text-xl font-bold text-gray-900 mb-6">Order Summary</h2>

      <div className="space-y-4 mb-6">
        {items.map((item) => (
          <div key={`${item.id}-${item.variant || 'novar'}`} className="flex space-x-4">
            <div className="relative w-20 h-20 bg-gray-100 rounded-lg overflow-hidden flex-shrink-0">
              <img
                src={item.image}
                alt={item.name}
                className="w-full h-full object-cover"
              />
              <div className="absolute -top-2 -right-2 w-6 h-6 flex items-center justify-center bg-gray-900 text-white text-xs font-bold rounded-full">
                {item.quantity}
              </div>
            </div>
            <div className="flex-1">
              <h3 className="font-semibold text-gray-900 text-sm line-clamp-2">{item.name}</h3>
              {item.variant && <p className="text-xs text-gray-500 mt-0.5">{item.variant}</p>}
              <p className="text-gray-900 font-bold mt-1">GH₵ {item.price.toFixed(2)}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="border-t border-gray-200 pt-4 space-y-3">
        <div className="flex justify-between text-gray-700">
          <span>Subtotal</span>
          <span className="font-semibold">GH₵ {subtotal.toFixed(2)}</span>
        </div>
        <div className="flex justify-between text-gray-700">
          <span>Shipping</span>
          <span className="font-semibold">
            {shipping === 0 ? 'FREE' : `GH₵ ${shipping.toFixed(2)}`}
          </span>
        </div>

      </div>

      <div className="border-t border-gray-200 mt-4 pt-4">
        <div className="flex justify-between items-center">
          <span className="text-lg font-bold text-gray-900">Total</span>
          <span className="text-2xl font-bold text-gray-900">GH₵ {total.toFixed(2)}</span>
        </div>
      </div>

      {isDeposit && (
        <div className="mt-4 p-4 bg-amber-50 border border-amber-200 rounded-lg space-y-2">
          <div className="flex items-center gap-2 text-amber-800 font-semibold text-sm">
            <i className="ri-wallet-3-line text-base"></i>
            <span>50% Deposit Plan</span>
          </div>
          <div className="flex justify-between text-sm text-gray-700">
            <span>Pay now (50%)</span>
            <span className="font-semibold text-emerald-700">GH₵ {depositAmount.toFixed(2)}</span>
          </div>
          <div className="flex justify-between text-sm text-gray-700">
            <span>Balance on delivery/pickup</span>
            <span className="font-semibold text-amber-700">GH₵ {balanceDue.toFixed(2)}</span>
          </div>
        </div>
      )}

      <div className="mt-6 p-4 bg-gray-50 border border-gray-200 rounded-lg">
        <div className="flex items-center space-x-2 text-gray-800">
          <i className="ri-shield-check-line text-xl"></i>
          <p className="text-sm font-semibold">Secure Checkout</p>
        </div>
      </div>
    </div>
  );
}
