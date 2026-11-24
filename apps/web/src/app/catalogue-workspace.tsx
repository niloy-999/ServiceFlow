"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001/api/v1";

type Membership = {
  membershipId: string;
  business: { id: string; name: string; currency: string };
};
type Category = { id: string; name: string; parentId: string | null; status: string };
type Brand = { id: string; name: string; status: string };
type Variant = {
  id: string;
  variantCode: string;
  sku: string;
  name: string;
  attributes: Record<string, unknown>;
  isDefault: boolean;
  status: string;
  version: string;
  priceMinor: string | null;
  currency: string | null;
};
type Product = {
  id: string;
  productCode: string;
  name: string;
  description: string | null;
  productKind: "RETAIL" | "REPAIR_PART" | "BOTH";
  categoryId: string | null;
  categoryName: string | null;
  brandId: string | null;
  brandName: string | null;
  trackSerials: boolean;
  status: string;
  version: string;
  variants: Variant[];
};
type VariantDraft = { variantCode: string; sku: string; name: string; priceMinor: string };

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; csrf?: string } = {},
) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? "GET",
    credentials: "include",
    headers: {
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(options.method && options.method !== "GET" ? { "X-CSRF-Token": options.csrf ?? "" } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message =
      typeof result.message === "string" ? result.message : "The request could not be completed.";
    throw new Error(message);
  }
  return result as T;
}

export default function CatalogueWorkspace() {
  const [csrf, setCsrf] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [challenge, setChallenge] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [tenantId, setTenantId] = useState("");
  const [categories, setCategories] = useState<Category[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [selected, setSelected] = useState<Product | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [categoryName, setCategoryName] = useState("");
  const [brandName, setBrandName] = useState("");
  const [categoryEdit, setCategoryEdit] = useState<Category | null>(null);
  const [brandEdit, setBrandEdit] = useState<Brand | null>(null);
  const [productCode, setProductCode] = useState("");
  const [productName, setProductName] = useState("");
  const [productKind, setProductKind] = useState<Product["productKind"]>("RETAIL");
  const [productDescription, setProductDescription] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [brandId, setBrandId] = useState("");
  const [trackSerials, setTrackSerials] = useState(false);
  const [useVariants, setUseVariants] = useState(false);
  const [defaultSku, setDefaultSku] = useState("");
  const [defaultPrice, setDefaultPrice] = useState("");
  const [variantDrafts, setVariantDrafts] = useState<VariantDraft[]>([
    { variantCode: "DEFAULT", sku: "", name: "", priceMinor: "" },
  ]);
  const [editingVariant, setEditingVariant] = useState<Variant | null>(null);
  const [variantName, setVariantName] = useState("");
  const [variantSku, setVariantSku] = useState("");
  const [variantPrice, setVariantPrice] = useState("");
  const [showProductForm, setShowProductForm] = useState(false);
  const [showAddVariant, setShowAddVariant] = useState(false);
  const [newVariant, setNewVariant] = useState<VariantDraft>({
    variantCode: "",
    sku: "",
    name: "",
    priceMinor: "",
  });

  const loadMemberships = useCallback(async () => {
    const result = await request<{ memberships: Membership[] }>("/auth/memberships");
    setMemberships(result.memberships);
    setTenantId((current) => current || result.memberships[0]?.business.id || "");
  }, []);

  const loadCatalogue = useCallback(async () => {
    if (!tenantId) return;
    setLoading(true);
    setError("");
    try {
      const [categoryResult, brandResult, productResult] = await Promise.all([
        request<{ categories: Category[] }>(`/catalogue/${tenantId}/categories`),
        request<{ brands: Brand[] }>(`/catalogue/${tenantId}/brands`),
        request<{ products: Product[] }>(`/catalogue/${tenantId}/products`),
      ]);
      setCategories(categoryResult.categories);
      setBrands(brandResult.brands);
      setProducts(productResult.products);
      setSelected((current) =>
        current
          ? (productResult.products.find((product) => product.id === current.id) ?? null)
          : null,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Catalogue could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    let active = true;
    request<{ csrfToken: string }>("/auth/csrf")
      .then(async (result) => {
        if (!active) return;
        setCsrf(result.csrfToken);
        await loadMemberships();
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [loadMemberships]);

  useEffect(() => {
    void loadCatalogue();
  }, [loadCatalogue]);

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const result = await request<{
        mfaRequired: boolean;
        challengeToken?: string;
        csrfToken?: string;
      }>("/auth/login", { method: "POST", body: { email, password } });
      if (result.mfaRequired && result.challengeToken) {
        setChallenge(result.challengeToken);
      } else if (result.csrfToken) {
        setCsrf(result.csrfToken);
        setPassword("");
        await loadMemberships();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign in failed.");
    } finally {
      setLoading(false);
    }
  }

  async function handleMfa(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const result = await request<{ csrfToken: string }>("/auth/mfa/verify", {
        method: "POST",
        body: { challengeToken: challenge, code: mfaCode.trim() },
      });
      setCsrf(result.csrfToken);
      setChallenge("");
      setMfaCode("");
      setPassword("");
      await loadMemberships();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "MFA verification failed.");
    } finally {
      setLoading(false);
    }
  }

  async function mutate(path: string, body: unknown) {
    return request<Record<string, unknown>>(path, { method: "POST", body, csrf });
  }

  async function saveCategory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!tenantId) return;
    setError("");
    try {
      if (categoryEdit) {
        await mutate(`/catalogue/categories/${categoryEdit.id}/update`, {
          tenantId,
          name: categoryName,
        });
        setNotice("Category updated.");
      } else {
        await mutate("/catalogue/categories", { tenantId, name: categoryName });
        setNotice("Category created.");
      }
      setCategoryName("");
      setCategoryEdit(null);
      await loadCatalogue();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Category could not be saved.");
    }
  }

  async function saveBrand(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!tenantId) return;
    setError("");
    try {
      if (brandEdit) {
        await mutate(`/catalogue/brands/${brandEdit.id}/update`, { tenantId, name: brandName });
        setNotice("Brand updated.");
      } else {
        await mutate("/catalogue/brands", { tenantId, name: brandName });
        setNotice("Brand created.");
      }
      setBrandName("");
      setBrandEdit(null);
      await loadCatalogue();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Brand could not be saved.");
    }
  }

  function resetProductForm() {
    setSelected(null);
    setProductCode("");
    setProductName("");
    setProductDescription("");
    setProductKind("RETAIL");
    setCategoryId("");
    setBrandId("");
    setTrackSerials(false);
    setUseVariants(false);
    setDefaultSku("");
    setDefaultPrice("");
    setVariantDrafts([{ variantCode: "DEFAULT", sku: "", name: "", priceMinor: "" }]);
    setEditingVariant(null);
    setShowProductForm(true);
  }

  function selectProduct(product: Product) {
    setSelected(product);
    setProductCode(product.productCode);
    setProductName(product.name);
    setProductDescription(product.description ?? "");
    setProductKind(product.productKind);
    setCategoryId(product.categoryId ?? "");
    setBrandId(product.brandId ?? "");
    setTrackSerials(product.trackSerials);
    setShowProductForm(true);
    setEditingVariant(null);
  }

  async function saveProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!tenantId) return;
    setLoading(true);
    setError("");
    const shared = {
      tenantId,
      name: productName,
      description: productDescription,
      productKind,
      categoryId: categoryId || null,
      brandId: brandId || null,
      trackSerials,
    };
    try {
      if (selected) {
        await mutate(`/catalogue/products/${selected.id}/update`, {
          ...shared,
          version: Number(selected.version),
        });
        setNotice("Product updated.");
      } else {
        const variants = useVariants
          ? variantDrafts.map(({ variantCode, sku, name, priceMinor }, index) => ({
              variantCode,
              sku,
              name,
              ...(priceMinor === "" ? {} : { priceMinor: Number(priceMinor) }),
              isDefault: index === 0,
            }))
          : undefined;
        await mutate("/catalogue/products", {
          ...shared,
          productCode,
          ...(useVariants
            ? { variants }
            : {
                sku: defaultSku,
                ...(defaultPrice === "" ? {} : { priceMinor: Number(defaultPrice) }),
              }),
        });
        setNotice("Product created with its stock variant.");
      }
      await loadCatalogue();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Product could not be saved.");
    } finally {
      setLoading(false);
    }
  }

  async function archiveProduct() {
    if (!selected || !tenantId) return;
    setError("");
    try {
      await mutate(`/catalogue/products/${selected.id}/archive`, { tenantId });
      setSelected(null);
      setShowProductForm(false);
      setNotice("Product archived.");
      await loadCatalogue();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Product could not be archived.");
    }
  }

  async function saveVariant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingVariant || !tenantId) return;
    setError("");
    try {
      await mutate(`/catalogue/variants/${editingVariant.id}/update`, {
        tenantId,
        version: Number(editingVariant.version),
        sku: variantSku,
        name: variantName,
        attributes: editingVariant.attributes,
        ...(variantPrice === ""
          ? {}
          : { priceMinor: Number(variantPrice), currency: editingVariant.currency ?? "BDT" }),
      });
      setEditingVariant(null);
      setNotice("Variant updated; its previous price remains in history.");
      await loadCatalogue();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Variant could not be saved.");
    }
  }

  async function addVariant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !tenantId) return;
    setError("");
    try {
      await mutate(`/catalogue/products/${selected.id}/variants`, {
        tenantId,
        variantCode: newVariant.variantCode,
        sku: newVariant.sku,
        name: newVariant.name,
        isDefault: false,
        attributes: {},
        ...(newVariant.priceMinor === "" ? {} : { priceMinor: Number(newVariant.priceMinor) }),
      });
      setNewVariant({ variantCode: "", sku: "", name: "", priceMinor: "" });
      setShowAddVariant(false);
      setNotice("Variant added.");
      await loadCatalogue();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Variant could not be added.");
    }
  }

  async function logout() {
    try {
      await mutate("/auth/logout", {});
    } finally {
      setCsrf("");
      setMemberships([]);
      setTenantId("");
      setProducts([]);
      setCategories([]);
      setBrands([]);
      setSelected(null);
    }
  }

  if (!csrf && !challenge) {
    return (
      <main className="workspace-shell">
        <section className="auth-card" aria-labelledby="signin-title">
          <p className="eyebrow">SERVICEFLOW · RELEASE 0.2</p>
          <h1 id="signin-title">Catalogue workspace</h1>
          <p className="muted">
            Sign in with an active business account to manage products and variants.
          </p>
          <form className="stack" onSubmit={handleLogin}>
            <label>
              Email
              <input
                autoComplete="username"
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <label>
              Password
              <input
                autoComplete="current-password"
                type="password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <button disabled={loading} type="submit">
              {loading ? "Signing in…" : "Sign in"}
            </button>
          </form>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </section>
      </main>
    );
  }

  if (challenge) {
    return (
      <main className="workspace-shell">
        <section className="auth-card" aria-labelledby="mfa-title">
          <p className="eyebrow">SECURE SIGN IN</p>
          <h1 id="mfa-title">Verify your sign in</h1>
          <p className="muted">Enter your authenticator code or a recovery code.</p>
          <form className="stack" onSubmit={handleMfa}>
            <label>
              Verification code
              <input
                autoComplete="one-time-code"
                inputMode="text"
                required
                value={mfaCode}
                onChange={(event) => setMfaCode(event.target.value)}
              />
            </label>
            <button disabled={loading} type="submit">
              {loading ? "Verifying…" : "Verify"}
            </button>
          </form>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </section>
      </main>
    );
  }

  const activeProducts = products.filter((product) => product.status === "ACTIVE");
  return (
    <main className="workspace-shell">
      <header className="workspace-header">
        <div>
          <p className="eyebrow">SERVICEFLOW · 0.2 CATALOGUE</p>
          <h1>Catalogue</h1>
        </div>
        <div className="header-actions">
          <label className="tenant-select">
            Business
            <select
              value={tenantId}
              onChange={(event) => {
                setTenantId(event.target.value);
                setSelected(null);
              }}
            >
              {memberships.map((membership) => (
                <option key={membership.membershipId} value={membership.business.id}>
                  {membership.business.name}
                </option>
              ))}
            </select>
          </label>
          <button className="button-secondary" onClick={() => void logout()} type="button">
            Sign out
          </button>
        </div>
      </header>
      {memberships.length === 0 ? (
        <section className="panel">
          <h2>No active business workspace</h2>
          <p className="muted">
            Your account has no active business membership. Pending registrations cannot access
            catalogue data.
          </p>
        </section>
      ) : (
        <>
          {error && (
            <p className="error banner" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className="notice banner" role="status">
              {notice}
            </p>
          )}
          <section className="catalogue-grid">
            <aside className="panel side-panel">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">ORGANIZE</p>
                  <h2>Categories</h2>
                </div>
              </div>
              <form className="inline-form" onSubmit={saveCategory}>
                <label className="sr-only" htmlFor="category-name">
                  Category name
                </label>
                <input
                  id="category-name"
                  required
                  maxLength={120}
                  placeholder="New category"
                  value={categoryName}
                  onChange={(event) => setCategoryName(event.target.value)}
                />
                <button aria-label={categoryEdit ? "Save category" : "Add category"} type="submit">
                  {categoryEdit ? "Save" : "Add"}
                </button>
              </form>
              {categories.length === 0 ? (
                <p className="empty-copy">No categories yet.</p>
              ) : (
                <ul className="simple-list">
                  {categories.map((category) => (
                    <li key={category.id}>
                      <span className={category.status === "ARCHIVED" ? "archived-text" : ""}>
                        {category.name}
                      </span>
                      {category.status === "ACTIVE" && (
                        <button
                          className="text-button"
                          onClick={() => {
                            setCategoryEdit(category);
                            setCategoryName(category.name);
                          }}
                          type="button"
                        >
                          Edit
                        </button>
                      )}
                      {category.status === "ACTIVE" && (
                        <button
                          className="text-button danger-text"
                          onClick={async () => {
                            try {
                              await mutate(`/catalogue/categories/${category.id}/archive`, {
                                tenantId,
                              });
                              await loadCatalogue();
                            } catch (cause) {
                              setError(
                                cause instanceof Error
                                  ? cause.message
                                  : "Category could not be archived.",
                              );
                            }
                          }}
                          type="button"
                        >
                          Archive
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <div className="divider" />
              <div className="section-heading">
                <div>
                  <p className="eyebrow">ORGANIZE</p>
                  <h2>Brands</h2>
                </div>
              </div>
              <form className="inline-form" onSubmit={saveBrand}>
                <label className="sr-only" htmlFor="brand-name">
                  Brand name
                </label>
                <input
                  id="brand-name"
                  required
                  maxLength={120}
                  placeholder="New brand"
                  value={brandName}
                  onChange={(event) => setBrandName(event.target.value)}
                />
                <button aria-label={brandEdit ? "Save brand" : "Add brand"} type="submit">
                  {brandEdit ? "Save" : "Add"}
                </button>
              </form>
              {brands.length === 0 ? (
                <p className="empty-copy">No brands yet.</p>
              ) : (
                <ul className="simple-list">
                  {brands.map((brand) => (
                    <li key={brand.id}>
                      <span className={brand.status === "ARCHIVED" ? "archived-text" : ""}>
                        {brand.name}
                      </span>
                      {brand.status === "ACTIVE" && (
                        <button
                          className="text-button"
                          onClick={() => {
                            setBrandEdit(brand);
                            setBrandName(brand.name);
                          }}
                          type="button"
                        >
                          Edit
                        </button>
                      )}
                      {brand.status === "ACTIVE" && (
                        <button
                          className="text-button danger-text"
                          onClick={async () => {
                            try {
                              await mutate(`/catalogue/brands/${brand.id}/archive`, { tenantId });
                              await loadCatalogue();
                            } catch (cause) {
                              setError(
                                cause instanceof Error
                                  ? cause.message
                                  : "Brand could not be archived.",
                              );
                            }
                          }}
                          type="button"
                        >
                          Archive
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </aside>

            <section className="panel product-panel">
              <div className="section-heading product-heading">
                <div>
                  <p className="eyebrow">STOCK IDENTITY STARTS HERE</p>
                  <h2>Products and variants</h2>
                  <p className="muted">
                    Each variant has its own SKU, price history and future stock identity.
                  </p>
                </div>
                <button onClick={resetProductForm} type="button">
                  New product
                </button>
              </div>
              {loading && (
                <p className="muted" role="status">
                  Loading catalogue…
                </p>
              )}
              {activeProducts.length === 0 && !loading ? (
                <div className="empty-state">
                  <h3>Your catalogue is ready</h3>
                  <p>
                    Add a product to create its default stock variant, or define variant SKUs up
                    front.
                  </p>
                  <button onClick={resetProductForm} type="button">
                    Create first product
                  </button>
                </div>
              ) : (
                <div className="product-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Product</th>
                        <th>Kind</th>
                        <th>Default SKU</th>
                        <th>Variants</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activeProducts.map((product) => (
                        <tr key={product.id}>
                          <td>
                            <button
                              className="product-link"
                              onClick={() => selectProduct(product)}
                              type="button"
                            >
                              {product.name}
                            </button>
                            <span className="table-secondary">{product.productCode}</span>
                          </td>
                          <td>
                            <span className="pill">{product.productKind.replace("_", " ")}</span>
                          </td>
                          <td>
                            {product.variants.find((variant) => variant.isDefault)?.sku ?? "—"}
                          </td>
                          <td>{product.variants.length}</td>
                          <td>{product.trackSerials ? "Serial tracked" : "Quantity tracked"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </section>

          {showProductForm && (
            <section className="panel editor-panel" aria-labelledby="product-editor-title">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">
                    {selected ? "EDIT CATALOGUE GROUP" : "NEW CATALOGUE GROUP"}
                  </p>
                  <h2 id="product-editor-title">{selected ? selected.name : "Product details"}</h2>
                </div>
                <button
                  className="button-secondary"
                  onClick={() => {
                    setShowProductForm(false);
                    setSelected(null);
                  }}
                  type="button"
                >
                  Close
                </button>
              </div>
              <form className="form-grid" onSubmit={saveProduct}>
                {!selected && (
                  <label>
                    Product code
                    <input
                      required
                      maxLength={64}
                      value={productCode}
                      onChange={(event) => setProductCode(event.target.value)}
                    />
                  </label>
                )}
                <label>
                  Product name
                  <input
                    required
                    maxLength={180}
                    value={productName}
                    onChange={(event) => setProductName(event.target.value)}
                  />
                </label>
                <label>
                  Classification
                  <select
                    value={productKind}
                    onChange={(event) =>
                      setProductKind(event.target.value as Product["productKind"])
                    }
                  >
                    <option value="RETAIL">Retail</option>
                    <option value="REPAIR_PART">Repair part</option>
                    <option value="BOTH">Both</option>
                  </select>
                </label>
                <label>
                  Category
                  <select
                    value={categoryId}
                    onChange={(event) => setCategoryId(event.target.value)}
                  >
                    <option value="">No category</option>
                    {categories
                      .filter((item) => item.status === "ACTIVE")
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  Brand
                  <select value={brandId} onChange={(event) => setBrandId(event.target.value)}>
                    <option value="">No brand</option>
                    {brands
                      .filter((item) => item.status === "ACTIVE")
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={trackSerials}
                    onChange={(event) => setTrackSerials(event.target.checked)}
                  />{" "}
                  Track serial numbers on physical units
                </label>
                <label className="wide-field">
                  Description
                  <textarea
                    maxLength={2000}
                    rows={3}
                    value={productDescription}
                    onChange={(event) => setProductDescription(event.target.value)}
                  />
                </label>
                {!selected && (
                  <div className="variant-builder wide-field">
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={useVariants}
                        onChange={(event) => setUseVariants(event.target.checked)}
                      />{" "}
                      This product has explicit variants
                    </label>
                    {!useVariants ? (
                      <div className="form-grid">
                        <label>
                          Default variant SKU
                          <input
                            required
                            value={defaultSku}
                            onChange={(event) => setDefaultSku(event.target.value)}
                          />
                        </label>
                        <label>
                          Initial price in minor units
                          <input
                            inputMode="numeric"
                            min="0"
                            pattern="[0-9]*"
                            value={defaultPrice}
                            onChange={(event) => setDefaultPrice(event.target.value)}
                          />
                          <small>For BDT, 100 poisha = ৳1. Leave blank if not priced yet.</small>
                        </label>
                      </div>
                    ) : (
                      <>
                        {variantDrafts.map((variant, index) => (
                          <div className="form-grid variant-row" key={index}>
                            <label>
                              Variant code
                              <input
                                required
                                maxLength={64}
                                value={variant.variantCode}
                                onChange={(event) =>
                                  setVariantDrafts((current) =>
                                    current.map((item, i) =>
                                      i === index
                                        ? { ...item, variantCode: event.target.value }
                                        : item,
                                    ),
                                  )
                                }
                              />
                            </label>
                            <label>
                              SKU
                              <input
                                required
                                maxLength={100}
                                value={variant.sku}
                                onChange={(event) =>
                                  setVariantDrafts((current) =>
                                    current.map((item, i) =>
                                      i === index ? { ...item, sku: event.target.value } : item,
                                    ),
                                  )
                                }
                              />
                            </label>
                            <label>
                              Variant name
                              <input
                                required
                                maxLength={180}
                                value={variant.name}
                                onChange={(event) =>
                                  setVariantDrafts((current) =>
                                    current.map((item, i) =>
                                      i === index ? { ...item, name: event.target.value } : item,
                                    ),
                                  )
                                }
                              />
                            </label>
                            <label>
                              Price in minor units
                              <input
                                inputMode="numeric"
                                min="0"
                                pattern="[0-9]*"
                                value={variant.priceMinor}
                                onChange={(event) =>
                                  setVariantDrafts((current) =>
                                    current.map((item, i) =>
                                      i === index
                                        ? { ...item, priceMinor: event.target.value }
                                        : item,
                                    ),
                                  )
                                }
                              />
                            </label>
                          </div>
                        ))}
                        <button
                          className="button-secondary"
                          onClick={() =>
                            setVariantDrafts((current) => [
                              ...current,
                              { variantCode: "", sku: "", name: "", priceMinor: "" },
                            ])
                          }
                          type="button"
                        >
                          Add another variant
                        </button>
                      </>
                    )}
                  </div>
                )}
                <div className="form-actions wide-field">
                  <button disabled={loading} type="submit">
                    {selected ? "Save product" : "Create product and stock variant"}
                  </button>
                  {selected && (
                    <button
                      className="button-danger"
                      onClick={() => void archiveProduct()}
                      type="button"
                    >
                      Archive product
                    </button>
                  )}
                </div>
              </form>
              {selected && (
                <div className="variant-list">
                  <div className="section-heading">
                    <h3>Variants</h3>
                    <button
                      className="button-secondary"
                      onClick={() => setShowAddVariant((value) => !value)}
                      type="button"
                    >
                      Add variant
                    </button>
                  </div>
                  {showAddVariant && (
                    <form className="form-grid variant-edit" onSubmit={addVariant}>
                      <label>
                        Variant code
                        <input
                          required
                          maxLength={64}
                          value={newVariant.variantCode}
                          onChange={(event) =>
                            setNewVariant((current) => ({
                              ...current,
                              variantCode: event.target.value,
                            }))
                          }
                        />
                      </label>
                      <label>
                        SKU
                        <input
                          required
                          maxLength={100}
                          value={newVariant.sku}
                          onChange={(event) =>
                            setNewVariant((current) => ({ ...current, sku: event.target.value }))
                          }
                        />
                      </label>
                      <label>
                        Variant name
                        <input
                          required
                          maxLength={180}
                          value={newVariant.name}
                          onChange={(event) =>
                            setNewVariant((current) => ({ ...current, name: event.target.value }))
                          }
                        />
                      </label>
                      <label>
                        Price in minor units
                        <input
                          inputMode="numeric"
                          min="0"
                          pattern="[0-9]*"
                          value={newVariant.priceMinor}
                          onChange={(event) =>
                            setNewVariant((current) => ({
                              ...current,
                              priceMinor: event.target.value,
                            }))
                          }
                        />
                      </label>
                      <div className="form-actions wide-field">
                        <button type="submit">Create variant</button>
                        <button
                          className="button-secondary"
                          onClick={() => setShowAddVariant(false)}
                          type="button"
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  )}
                  {selected.variants.map((variant) => (
                    <article className="variant-card" key={variant.id}>
                      <div>
                        <strong>{variant.name}</strong>
                        {variant.isDefault && <span className="pill">Default</span>}
                        <p className="table-secondary">
                          {variant.sku} ·{" "}
                          {variant.priceMinor === null
                            ? "No current price"
                            : `${variant.currency} minor ${variant.priceMinor}`}
                        </p>
                      </div>
                      <div className="row-actions">
                        <button
                          className="text-button"
                          onClick={() => {
                            setEditingVariant(variant);
                            setVariantName(variant.name);
                            setVariantSku(variant.sku);
                            setVariantPrice(variant.priceMinor ?? "");
                          }}
                          type="button"
                        >
                          Edit variant
                        </button>
                        {!variant.isDefault && (
                          <button
                            className="text-button"
                            onClick={async () => {
                              try {
                                await mutate(`/catalogue/variants/${variant.id}/default`, {
                                  tenantId,
                                });
                                await loadCatalogue();
                              } catch (cause) {
                                setError(
                                  cause instanceof Error
                                    ? cause.message
                                    : "Default variant could not be changed.",
                                );
                              }
                            }}
                            type="button"
                          >
                            Make default
                          </button>
                        )}
                        {variant.status === "ACTIVE" && !variant.isDefault && (
                          <button
                            className="text-button danger-text"
                            onClick={async () => {
                              try {
                                await mutate(`/catalogue/variants/${variant.id}/archive`, {
                                  tenantId,
                                });
                                await loadCatalogue();
                              } catch (cause) {
                                setError(
                                  cause instanceof Error
                                    ? cause.message
                                    : "Variant could not be archived.",
                                );
                              }
                            }}
                            type="button"
                          >
                            Archive
                          </button>
                        )}
                      </div>
                      {editingVariant?.id === variant.id && (
                        <form className="form-grid variant-edit" onSubmit={saveVariant}>
                          <label>
                            Variant name
                            <input
                              required
                              value={variantName}
                              onChange={(event) => setVariantName(event.target.value)}
                            />
                          </label>
                          <label>
                            SKU
                            <input
                              required
                              value={variantSku}
                              onChange={(event) => setVariantSku(event.target.value)}
                            />
                          </label>
                          <label>
                            New price in minor units
                            <input
                              inputMode="numeric"
                              min="0"
                              pattern="[0-9]*"
                              value={variantPrice}
                              onChange={(event) => setVariantPrice(event.target.value)}
                            />
                            <small>Submitting creates a new price-history entry.</small>
                          </label>
                          <div className="form-actions">
                            <button type="submit">Save variant</button>
                            <button
                              className="button-secondary"
                              onClick={() => setEditingVariant(null)}
                              type="button"
                            >
                              Cancel
                            </button>
                          </div>
                        </form>
                      )}
                    </article>
                  ))}
                </div>
              )}
            </section>
          )}
        </>
      )}
      <footer className="workspace-footer">
        Catalogue details are ready to connect with branch inventory workflows.
      </footer>
    </main>
  );
}
