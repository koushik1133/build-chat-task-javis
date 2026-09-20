"use client";
import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";

interface Property {
  id: string;
  address?: string;
  city?: string;
  state?: string;
  price?: number | string;
  bedrooms?: number | string;
  bathrooms?: number | string;
  sqft?: number | string;
}

interface InvestmentResult {
  roi?: string | number;
  cap_rate?: string | number;
  monthly_cashflow?: string | number;
  recommendation?: string;
}

export default function RealEstateHub() {
  const [activeTab, setActiveTab] = useState("Property Listings");
  const [properties, setProperties] = useState<Property[]>([]);

  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [type, setType] = useState("");
  const [price, setPrice] = useState("");
  const [bedrooms, setBedrooms] = useState("");
  const [bathrooms, setBathrooms] = useState("");
  const [sqft, setSqft] = useState("");

  const [loading, setLoading] = useState(false);
  const [listingText, setListingText] = useState("");
  const [analysis, setAnalysis] = useState("");
  const [investment, setInvestment] = useState<InvestmentResult | null>(null);

  useEffect(() => {
    fetchProperties();
  }, []);

  const fetchProperties = async () => {
    try {
      const res = await fetch("/api/domains/realestate?action=properties");
      if (res.ok) {
        const data = await res.json();
        setProperties(Array.isArray(data.properties) ? data.properties : []);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const addProperty = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/domains/realestate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "add_property",
          address, city, state, property_type: type,
          price: Number(price), bedrooms: Number(bedrooms),
          bathrooms: Number(bathrooms), sqft: Number(sqft), status: "Available"
        })
      });
      if (res.ok) {
        fetchProperties();
        setAddress(""); setCity(""); setState(""); setType("");
        setPrice(""); setBedrooms(""); setBathrooms(""); setSqft("");
      }
    } catch {
      alert("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const generateListing = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/domains/realestate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "generate_listing",
          address: "123 Main St", bedrooms: 3, bathrooms: 2, sqft: 1500,
          features: "Pool, Hardwood floors", price: 500000, neighborhood: "Downtown"
        })
      });
      if (res.ok) {
        const data = await res.json();
        setListingText(data.listing_text ?? "");
      }
    } catch {
      alert("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const generateMarketAnalysis = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/domains/realestate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "market_analysis",
          city: "Austin", state: "TX", property_type: "Single Family", price_range: "$400k-$600k"
        })
      });
      if (res.ok) {
        const data = await res.json();
        setAnalysis(data.analysis ?? "");
      }
    } catch {
      alert("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const calculateInvestment = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/domains/realestate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "investment_analysis",
          purchase_price: 500000, monthly_rent: 3000, expenses: 1000, financing_rate: 6.5
        })
      });
      if (res.ok) {
        const data = await res.json();
        setInvestment(data);
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
        <h1 className="text-3xl font-bold text-amber-600">🏠 Real Estate Hub</h1>
      </div>

      <div className="flex space-x-2 border-b border-border pb-2 overflow-x-auto whitespace-nowrap">
        {["Property Listings", "AI Listing Generator", "Market Analysis", "Investment Calculator"].map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 rounded-t-lg font-medium transition-colors ${
              activeTab === tab
                ? "bg-amber-600/10 text-amber-600 border-b-2 border-amber-600"
                : "text-muted-foreground hover:bg-card"
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {activeTab === "Property Listings" && (
        <div className="space-y-4">
          <div className="rounded-xl border border-border bg-card p-5 space-y-4">
            <h2 className="text-xl font-semibold">Add Property</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <input placeholder="Address" className="p-2 rounded border bg-background" value={address} onChange={e=>setAddress(e.target.value)} />
              <input placeholder="City" className="p-2 rounded border bg-background" value={city} onChange={e=>setCity(e.target.value)} />
              <input placeholder="State" className="p-2 rounded border bg-background" value={state} onChange={e=>setState(e.target.value)} />
              <input placeholder="Type" className="p-2 rounded border bg-background" value={type} onChange={e=>setType(e.target.value)} />
              <input type="number" placeholder="Price" className="p-2 rounded border bg-background" value={price} onChange={e=>setPrice(e.target.value)} />
              <input type="number" placeholder="Beds" className="p-2 rounded border bg-background" value={bedrooms} onChange={e=>setBedrooms(e.target.value)} />
              <input type="number" placeholder="Baths" className="p-2 rounded border bg-background" value={bathrooms} onChange={e=>setBathrooms(e.target.value)} />
              <input type="number" placeholder="Sqft" className="p-2 rounded border bg-background" value={sqft} onChange={e=>setSqft(e.target.value)} />
            </div>
            <Button onClick={addProperty} disabled={loading}>Add Property</Button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {properties.map(p => (
              <div key={p.id} className="rounded-xl border border-border bg-card p-5">
                <h3 className="font-bold">{p.address}</h3>
                <p className="text-sm text-muted-foreground">{p.city}, {p.state}</p>
                <div className="mt-2 text-lg font-semibold text-amber-600">${p.price}</div>
                <div className="flex gap-2 text-sm mt-1">
                  <span>🛏️ {p.bedrooms}</span>
                  <span>🛁 {p.bathrooms}</span>
                  <span>📐 {p.sqft} sqft</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {activeTab === "AI Listing Generator" && (
        <div className="rounded-xl border border-border bg-card p-5 space-y-4">
          <Button onClick={generateListing} disabled={loading}>Generate Sample Listing</Button>
          {listingText && <div className="p-4 bg-muted rounded whitespace-pre-wrap">{listingText}</div>}
        </div>
      )}

      {activeTab === "Market Analysis" && (
        <div className="rounded-xl border border-border bg-card p-5 space-y-4">
          <Button onClick={generateMarketAnalysis} disabled={loading}>Analyze Sample Market</Button>
          {analysis && <div className="p-4 bg-muted rounded whitespace-pre-wrap">{analysis}</div>}
        </div>
      )}

      {activeTab === "Investment Calculator" && (
        <div className="rounded-xl border border-border bg-card p-5 space-y-4">
          <Button onClick={calculateInvestment} disabled={loading}>Calculate Sample Investment</Button>
          {investment && (
            <div className="grid grid-cols-2 gap-4">
              <div className="p-4 border rounded"><strong>ROI:</strong> {investment.roi}</div>
              <div className="p-4 border rounded"><strong>Cap Rate:</strong> {investment.cap_rate}</div>
              <div className="p-4 border rounded"><strong>Cash Flow:</strong> {investment.monthly_cashflow}</div>
              <div className="p-4 border rounded"><strong>Recommendation:</strong> {investment.recommendation}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
