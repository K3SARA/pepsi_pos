export const DEFAULT_TAX_RATE = 0;

export const PAYMENT_TYPES = ["cash", "card", "wallet", "credit"];

export const SOCKET_EVENTS = {
  STATE_SYNC: "state:sync",
  SALE_CREATED: "sale:created",
  PRODUCT_UPDATED: "product:updated",
  INVENTORY_UPDATED: "inventory:updated"
};

export const emptyCartLine = (product, quantity = 1) => ({
  productId: product.id,
  name: product.name,
  price: Number(product.billingPrice ?? product.price ?? product.mrp ?? 0),
  quantity,
  subtotal: Number((Number(product.billingPrice ?? product.price ?? product.mrp ?? 0) * quantity).toFixed(2))
});

export const calculateTotals = ({ lines, taxRate = DEFAULT_TAX_RATE, discount = 0 }) => {
  const subTotal = Number(lines.reduce((acc, line) => acc + line.price * line.quantity, 0).toFixed(2));
  const discountAmount = Number(Math.min(discount, subTotal).toFixed(2));
  const taxable = Number((subTotal - discountAmount).toFixed(2));
  const tax = Number((taxable * taxRate).toFixed(2));
  const total = Number((taxable + tax).toFixed(2));

  return {
    subTotal,
    discountAmount,
    taxable,
    tax,
    total,
    taxRate
  };
};
