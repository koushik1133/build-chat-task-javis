"use client";
import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";

interface Product {
  id: string;
  name?: string;
  category?: string;
  sku?: string;
  price?: number | string;
  stock_count?: number | string;
  low_stock?: boolean;
}

interface DescriptionData {
  description?: string;
  variations?: string[];
}

interface ReviewData {
  sentiment?: string;
  rating_out_of_5?: number | string;
  top_praise?: string;
  top_complaints?: string;
  improvements?: string;
}

interface AdData {
  headline?: string;
  ad_copy?: string;
  cta?: string;
}

export default function EcommerceHub() {
  const [activeTab, setActiveTab] = useState("Products");
  const [products, setProducts] = useState<Product[]>([]);

  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [sku, setSku] = useState("");
  const [price, setPrice] = useState("");
  const [stockCount, setStockCount] = useState("");
  const [stockThreshold, setStockThreshold] = useState("");

  const [loading, setLoading] = useState(false);
  
  const [descData, setDescData] = useState<DescriptionData | null>(null);
  const [reviewData, setReviewData] = useState<ReviewData | null>(null);
  const [adData, setAdData] = useState<AdData | null>(null);

  useEffect(() => {
    fetchProducts();
  }, []);

  const fetchProducts = async () => {
    try {
      const res = await fetch("/api/domains/ecommerce?action=products");
      if (res.ok) {
        const data = await res.json();
        setProducts(Array.isArray(data.products) ? data.products : []);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const addProduct = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/domains/ecommerce", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "add_product",
          name, category, sku,
          price: Number(price), stock_count: Number(stockCount), stock_threshold: Number(stockThreshold)
        })
      });
      if (res.ok) {
        fetchProducts();
        setName(""); setCategory(""); setSku(""); setPrice(""); setStockCount(""); setStockThreshold("");
      }
    } catch {
      alert("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const generateDescription = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/domains/ecommerce", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "generate_description",
          product_name: "Wireless Noise-Cancelling Headphones", features: "Bluetooth 5.0, 30hr battery, Active noise cancellation", target_audience: "Commuters, Audiophiles"
        })
      });
      if (res.ok) {
        const data = await res.json();
        setDescData(data);
      }
    } catch {
      alert("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const analyzeReviews = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/domains/ecommerce", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "analyze_reviews",
          product_name: "Wireless Noise-Cancelling Headphones",
          reviews_text: "Great sound but the battery life is terrible! I also think they fit too tight on my head."
        })
      });
      if (res.ok) {
        const data = await res.json();
        setReviewData(data);
      }
    } catch {
      alert("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const generateAdCopy = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/domains/ecommerce", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "generate_ad_copy",
          product_name: "Wireless Noise-Cancelling Headphones", usp: "Block out the world with 30hrs of playtime.", platform: "facebook"
        })
      });
      if (res.ok) {
        const data = await res.json();
        setAdData(data);
      }
    } catch {
      alert("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden p-4 sm:p-6 lg:p-8 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center space-x-3 mb-8">
        <h1 className="text-3xl font-bold text-violet-600">🛒 E-commerce Hub</h1>
      </div>

      <div className="flex space-x-2 border-b border-border pb-2 overflow-x-auto whitespace-nowrap">
        {["Products", "AI Description Writer", "Review Analyzer", "Ad Copy Generator"].map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 rounded-t-lg font-medium transition-colors ${
              activeTab === tab
                ? "bg-violet-600/10 text-violet-600 border-b-2 border-violet-600"
                : "text-muted-foreground hover:bg-card"
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {activeTab === "Products" && (
        <div className="space-y-4">
          <div className="rounded-xl border border-border bg-card p-5 space-y-4">
            <h2 className="text-xl font-semibold">Add Product</h2>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <input placeholder="Name" className="p-2 rounded border bg-background" value={name} onChange={e=>setName(e.target.value)} />
              <input placeholder="Category" className="p-2 rounded border bg-background" value={category} onChange={e=>setCategory(e.target.value)} />
              <input placeholder="SKU" className="p-2 rounded border bg-background" value={sku} onChange={e=>setSku(e.target.value)} />
              <input type="number" placeholder="Price" className="p-2 rounded border bg-background" value={price} onChange={e=>setPrice(e.target.value)} />
              <input type="number" placeholder="Stock Count" className="p-2 rounded border bg-background" value={stockCount} onChange={e=>setStockCount(e.target.value)} />
              <input type="number" placeholder="Stock Threshold" className="p-2 rounded border bg-background" value={stockThreshold} onChange={e=>setStockThreshold(e.target.value)} />
            </div>
            <Button onClick={addProduct} disabled={loading}>Add Product</Button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {products.map(p => (
              <div key={p.id} className="rounded-xl border border-border bg-card p-5 relative">
                {p.low_stock && (
                  <span className="absolute top-2 right-2 bg-red-100 text-red-700 text-xs font-bold px-2 py-1 rounded">Low Stock</span>
                )}
                <h3 className="font-bold pr-16">{p.name}</h3>
                <p className="text-sm text-muted-foreground">{p.category} | SKU: {p.sku}</p>
                <div className="mt-2 text-lg font-semibold text-violet-600">${p.price}</div>
                <div className="text-sm mt-1">Stock: {p.stock_count}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {activeTab === "AI Description Writer" && (
        <div className="rounded-xl border border-border bg-card p-5 space-y-4">
          <Button onClick={generateDescription} disabled={loading}>Generate Sample Description</Button>
          {descData && (
            <div className="space-y-4">
              <div className="p-4 bg-muted rounded whitespace-pre-wrap font-semibold">{descData.description}</div>
              <h3 className="font-bold">Variations:</h3>
              <ul className="list-disc pl-5 space-y-2">
                {descData.variations?.map((v: string, i: number) => <li key={i}>{v}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}

      {activeTab === "Review Analyzer" && (
        <div className="rounded-xl border border-border bg-card p-5 space-y-4">
          <Button onClick={analyzeReviews} disabled={loading}>Analyze Sample Reviews</Button>
          {reviewData && (
            <div className="grid grid-cols-2 gap-4">
              <div className="p-4 border rounded"><strong>Sentiment:</strong> {reviewData.sentiment}</div>
              <div className="p-4 border rounded"><strong>Rating:</strong> {reviewData.rating_out_of_5} / 5</div>
              <div className="p-4 border rounded"><strong>Top Praise:</strong> {reviewData.top_praise}</div>
              <div className="p-4 border rounded"><strong>Top Complaints:</strong> {reviewData.top_complaints}</div>
              <div className="p-4 border rounded col-span-2"><strong>Improvements:</strong> {reviewData.improvements}</div>
            </div>
          )}
        </div>
      )}

      {activeTab === "Ad Copy Generator" && (
        <div className="rounded-xl border border-border bg-card p-5 space-y-4">
          <Button onClick={generateAdCopy} disabled={loading}>Generate Sample Ad Copy (Facebook)</Button>
          {adData && (
            <div className="grid gap-4">
              <div className="p-4 border rounded"><strong>Headline:</strong> {adData.headline}</div>
              <div className="p-4 border rounded"><strong>Ad Copy:</strong> {adData.ad_copy}</div>
              <div className="p-4 border rounded"><strong>CTA:</strong> {adData.cta}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
