import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useActionData, useNavigation, useNavigate, useLoaderData } from "react-router";
import { authenticate } from "~/shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { HeadersFunction } from "react-router";
import prisma from "~/db.server";
import { useState } from "react";
import { getEntitlements } from "~/models/billing.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  
  const shop = await prisma.shop.findUnique({
    where: { domain: session.shop },
  });

  if (!shop) {
    return { 
      experienceUsed: 0, 
      experienceLimit: null,
      maxResultCount: 16, // All plans allow all resultCounts now (they just cost credits)
    };
  }

  const entitlements = await getEntitlements(shop.id);
  const experienceCount = await prisma.experience.count({
    where: { shopId: shop.id },
  });
  
  return { 
    experienceUsed: experienceCount,
    experienceLimit: entitlements.experiencesLimit,
    maxResultCount: 16, // All resultCounts (8/12/16) are available, they just cost credits
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { session } = await authenticate.admin(request);
    console.log("[CreateExperience] Action started", { shop: session.shop });
    
    let shop = await prisma.shop.findUnique({
      where: { domain: session.shop },
    });

    if (!shop) {
      console.log("[CreateExperience] Creating new shop", { domain: session.shop });
      shop = await prisma.shop.create({
        data: {
          domain: session.shop,
          accessToken: session.accessToken || "",
        },
      });
    }

    const formData = await request.formData();
    const name = formData.get("name") as string;
    const mode = formData.get("mode") as string;
    const resultCountStr = formData.get("resultCount") as string;
    const tone = formData.get("tone") as string | null;
    const includedCollections = formData.get("includedCollections") as string || "[]";
    const excludedTags = formData.get("excludedTags") as string || "[]";
    const inStockOnly = formData.get("inStockOnly") === "true" || formData.get("inStockOnly") === "on";
    const isDefault = formData.get("isDefault") === "true" || formData.get("isDefault") === "on";
    const questionsJson = formData.get("questionsJson") as string || "[]";
    
    console.log("[CreateExperience] Form data received", { 
      name, 
      mode, 
      resultCountStr, 
      inStockOnly, 
      isDefault 
    });
    
    // Validate required fields
    if (!name || name.trim() === "") {
      console.error("[CreateExperience] Validation error: Name is required");
      return { error: "Name is required" };
    }
    
    if (!mode) {
      console.error("[CreateExperience] Validation error: Mode is required");
      return { error: "Mode is required" };
    }
    
    // Validate mode
    const validModes = ["quiz", "chat", "hybrid"];
    if (!validModes.includes(mode)) {
      console.error("[CreateExperience] Validation error: Invalid mode", { mode, validModes });
      return { error: "Mode must be one of: quiz, chat, hybrid" };
    }
    
    if (!resultCountStr) {
      console.error("[CreateExperience] Validation error: Result count is required");
      return { error: "Result count is required" };
    }
    
    const resultCount = parseInt(resultCountStr, 10);
    if (isNaN(resultCount) || ![8, 12, 16].includes(resultCount)) {
      console.error("[CreateExperience] Validation error: Invalid result count", { resultCountStr, resultCount });
      return { error: "Result count must be 8, 12, or 16" };
    }

    // Check experience limits (not resultCount limits - resultCount just costs credits)
    const entitlements = await getEntitlements(shop.id);
    const experienceCount = await prisma.experience.count({
      where: { shopId: shop.id },
    });

    // If limit is null, it's unlimited (PRO plan)
    if (entitlements.experiencesLimit !== null && experienceCount >= entitlements.experiencesLimit) {
      console.error("[CreateExperience] Experience limit reached", { 
        experienceCount, 
        limit: entitlements.experiencesLimit 
      });
      return { 
        error: `You've reached your experience limit (${experienceCount} of ${entitlements.experiencesLimit}). Upgrade plan or add +3 / +10 Experience pack.` 
      };
    }

    // Validate JSON fields
    let parsedCollections: string[] = [];
    let parsedTags: string[] = [];
    
    try {
      if (includedCollections && includedCollections.trim() !== "") {
        parsedCollections = JSON.parse(includedCollections);
      }
    } catch (e) {
      return { error: "Included Collections must be valid JSON array (e.g., [\"id1\", \"id2\"] or leave empty)" };
    }
    
    try {
      if (excludedTags && excludedTags.trim() !== "") {
        parsedTags = JSON.parse(excludedTags);
      }
    } catch (e) {
      return { error: "Excluded Tags must be valid JSON array (e.g., [\"tag1\", \"tag2\"] or leave empty)" };
    }

    // Validate questionsJson - at least 1 question required
    let parsedQuestions: any[] = [];
    try {
      if (!questionsJson || questionsJson.trim() === "") {
        return { error: "At least one question is required" };
      }
      parsedQuestions = JSON.parse(questionsJson);
      if (!Array.isArray(parsedQuestions)) {
        return { error: "Questions must be a JSON array" };
      }
      if (parsedQuestions.length === 0) {
        return { error: "At least one question is required" };
      }
      // Validate each question has required fields
      const validTypes = ["text", "select"];
      for (let i = 0; i < parsedQuestions.length; i++) {
        const q = parsedQuestions[i];
        if (!q.type || !validTypes.includes(q.type)) {
          return { error: `Question ${i + 1}: type must be "text" or "select"` };
        }
        // Accept "question" field (normalize "prompt" to "question" if present)
        if (q.prompt && !q.question) {
          q.question = q.prompt;
          delete q.prompt;
        }
        if (!q.question || q.question.trim() === "") {
          return { error: `Question ${i + 1}: question text is required` };
        }
        if (q.type === "select") {
          if (!q.options || !Array.isArray(q.options) || q.options.length < 2) {
            return { error: `Question ${i + 1}: select must have at least 2 options` };
          }
          // Normalize options to {value, label} format
          parsedQuestions[i].options = q.options.map((opt: any) => {
            if (typeof opt === "string") {
              return { value: opt, label: opt };
            }
            if (typeof opt === "object" && opt.value !== undefined) {
              return { value: String(opt.value), label: String(opt.label || opt.value) };
            }
            return { value: String(opt), label: String(opt) };
          });
          // Validate normalized options
          for (let j = 0; j < parsedQuestions[i].options.length; j++) {
            const opt = parsedQuestions[i].options[j];
            if (!opt.value || opt.value.trim() === "" || !opt.label || opt.label.trim() === "") {
              return { error: `Question ${i + 1}, Option ${j + 1}: value and label are required` };
            }
          }
        }
      }
    } catch (e) {
      return { error: "Questions must be valid JSON array: " + (e instanceof Error ? e.message : String(e)) };
    }

    // If setting default, unset all other defaults for this shop first
    if (isDefault) {
      await prisma.experience.updateMany({
        where: {
          shopId: shop.id,
          isDefault: true,
        },
        data: {
          isDefault: false,
        },
      });
    }

    const experience = await prisma.experience.create({
      data: {
        shopId: shop.id,
        name,
        mode,
        resultCount,
        tone: tone || null,
        includedCollections: JSON.stringify(parsedCollections),
        excludedTags: JSON.stringify(parsedTags),
        inStockOnly,
        isDefault,
        questionsJson: JSON.stringify(parsedQuestions),
      },
    });

    console.log("[CreateExperience] Successfully created experience", { id: experience.id, name: experience.name });
    return redirect("/app/experiences");
  } catch (error) {
    console.error("[CreateExperience] Error creating experience:", error);
    const errorMessage = error instanceof Error ? error.message : "Failed to create experience";
    return { error: errorMessage };
  }
};

export default function NewExperience() {
  const { maxResultCount, experienceUsed, experienceLimit } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const isSubmitting = navigation.state === "submitting";

  // Check if creation is blocked
  const isLimitReached = experienceLimit !== null && experienceUsed >= experienceLimit;

  // Questions state - start with one empty text question
  const [questions, setQuestions] = useState<any[]>([
    { type: "text", question: "", placeholder: "" }
  ]);

  const [form, setForm] = useState({
    name: "",
    mode: "hybrid" as "quiz" | "chat" | "hybrid",
    resultCount: 8 as 8 | 12 | 16,
    tone: "",
    includedCollections: "",
    excludedTags: "",
    inStockOnly: false,
    isDefault: false,
    questionsJson: "[]",
  });

  // Validation errors
  const [errors, setErrors] = useState<{
    name?: string;
    mode?: string;
    resultCount?: string;
    questionsJson?: string;
    questions?: Record<number, string>;
  }>({});

  // Update form field
  const updateField = (field: keyof typeof form, value: any) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    // Clear error for this field
    if (errors[field as keyof typeof errors]) {
      setErrors((prev) => ({ ...prev, [field]: undefined }));
    }
  };

  // Update questions and sync to form
  const updateQuestions = (newQuestions: any[]) => {
    setQuestions(newQuestions);
    updateField("questionsJson", JSON.stringify(newQuestions));
    // Clear question errors
    if (errors.questions) {
      setErrors((prev) => ({ ...prev, questions: undefined, questionsJson: undefined }));
    }
  };

  // Validate form
  const validate = (): boolean => {
    const newErrors: typeof errors = {};
    
    if (!form.name || form.name.trim() === "") {
      newErrors.name = "Name is required";
    }
    
    if (!form.mode) {
      newErrors.mode = "Mode is required";
    }
    
    if (!form.resultCount || ![8, 12, 16].includes(form.resultCount)) {
      newErrors.resultCount = "Result count must be 8, 12, or 16";
    }

    // Validate questions - at least 1 question required
    if (questions.length === 0) {
      newErrors.questionsJson = "At least one question is required";
    } else {
      const questionErrors: Record<number, string> = {};
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        const validTypes = ["text", "select"];
        if (!q.type || !validTypes.includes(q.type)) {
          questionErrors[i] = `Type must be "text" or "select"`;
          continue;
        }
        if (!q.question || q.question.trim() === "") {
          questionErrors[i] = "Question text is required";
          continue;
        }
        if (q.type === "select") {
          if (!q.options || !Array.isArray(q.options) || q.options.length < 2) {
            questionErrors[i] = "Must have at least 2 options";
            continue;
          }
          for (let j = 0; j < q.options.length; j++) {
            const opt = q.options[j];
            if (typeof opt === "object") {
              if (!opt.value || opt.value.trim() === "" || !opt.label || opt.label.trim() === "") {
                questionErrors[i] = `Option ${j + 1}: value and label are required`;
                break;
              }
            } else if (!opt || String(opt).trim() === "") {
              questionErrors[i] = `Option ${j + 1}: value is required`;
              break;
            }
          }
        }
      }
      if (Object.keys(questionErrors).length > 0) {
        newErrors.questions = questionErrors;
        newErrors.questionsJson = "Please fix question errors";
      }
    }
    
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  // Handle form submit - validation happens client-side, form submits normally
  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    if (!validate()) {
      e.preventDefault();
      return false;
    }
    // Form will submit normally via React Router
  };

  return (
    <s-page heading="Create Experience">
      <Form method="post" onSubmit={handleSubmit}>
        <s-section>
          {actionData?.error && (
            <div style={{
              padding: "1rem",
              backgroundColor: "#FEF2F2",
              border: "1px solid #FCA5A5",
              borderRadius: "12px",
              marginBottom: "1rem",
              color: "#DC2626"
            }}>
              {actionData.error}
            </div>
          )}

          <s-stack direction="block" gap="base">
            {/* Experience limit status */}
            {experienceLimit !== null && (
              <div style={{
                padding: "1rem",
                backgroundColor: isLimitReached ? "#FEF2F2" : "#F0FDF4",
                border: `1px solid ${isLimitReached ? "#FCA5A5" : "#86EFAC"}`,
                borderRadius: "12px",
                marginBottom: "1rem",
                color: isLimitReached ? "#DC2626" : "#16A34A"
              }}>
                <div style={{ fontWeight: "500", marginBottom: "0.25rem" }}>
                  {isLimitReached ? "⚠️ Experience limit reached" : "Experience usage"}
                </div>
                <div style={{ fontSize: "0.875rem" }}>
                  {experienceUsed} of {experienceLimit} experiences used
                  {isLimitReached && (
                    <div style={{ marginTop: "0.5rem" }}>
                      Upgrade plan or add +3 / +10 Experience pack to create more.
                    </div>
                  )}
                </div>
              </div>
            )}

            <div>
              <label style={{ display: "block", marginBottom: "0.5rem", fontWeight: "500" }}>
                Name <span style={{ color: "#DC2626" }}>*</span>
              </label>
              <input
                type="text"
                name="name"
                required
                placeholder="My Experience"
                value={form.name}
                onChange={(e) => updateField("name", e.currentTarget.value)}
                style={{
                  width: "100%",
                  padding: "0.5rem",
                  border: errors.name ? "1px solid #EF4444" : "1px solid rgba(11,11,15,0.12)",
                  borderRadius: "12px",
                }}
              />
              {errors.name && (
                <div style={{ color: "#DC2626", fontSize: "0.875rem", marginTop: "0.25rem" }}>
                  {errors.name}
                </div>
              )}
            </div>

            <div>
              <label style={{ display: "block", marginBottom: "0.5rem", fontWeight: "500" }}>
                Mode <span style={{ color: "#DC2626" }}>*</span>
              </label>
              <select
                name="mode"
                required
                value={form.mode}
                onChange={(e) => {
                  const value = e.currentTarget.value as "quiz" | "chat" | "hybrid";
                  if (["quiz", "chat", "hybrid"].includes(value)) {
                    updateField("mode", value);
                  }
                }}
                style={{
                  width: "100%",
                  padding: "0.5rem",
                  border: errors.mode ? "1px solid #EF4444" : "1px solid rgba(11,11,15,0.12)",
                  borderRadius: "12px",
                }}
              >
                <option value="quiz">Guided Quiz</option>
                <option value="chat">Chat</option>
                <option value="hybrid">Hybrid (quiz then chat)</option>
              </select>
              {errors.mode && (
                <div style={{ color: "#DC2626", fontSize: "0.875rem", marginTop: "0.25rem" }}>
                  {errors.mode}
                </div>
              )}
            </div>

            <div>
              <label style={{ display: "block", marginBottom: "0.5rem", fontWeight: "500" }}>
                Result Count <span style={{ color: "#DC2626" }}>*</span>
              </label>
              <select
                name="resultCount"
                required
                value={String(form.resultCount)}
                onChange={(e) => {
                  const value = Number(e.currentTarget.value) as 8 | 12 | 16;
                  if ([8, 12, 16].includes(value)) {
                    updateField("resultCount", value);
                  }
                }}
                style={{
                  width: "100%",
                  padding: "0.5rem",
                  border: errors.resultCount ? "1px solid #EF4444" : "1px solid rgba(11,11,15,0.12)",
                  borderRadius: "12px",
                }}
              >
                {8 <= maxResultCount && <option value="8">8</option>}
                {12 <= maxResultCount && <option value="12">12</option>}
                {16 <= maxResultCount && <option value="16">16</option>}
                {8 > maxResultCount && <option value="8" disabled>8 (Upgrade required)</option>}
                {12 > maxResultCount && <option value="12" disabled>12 (Upgrade required)</option>}
                {16 > maxResultCount && <option value="16" disabled>16 (Upgrade required)</option>}
              </select>
              <div style={{ fontSize: "0.875rem", color: "rgba(11,11,15,0.62)", marginTop: "0.25rem" }}>
                All result counts are available. Higher counts use more credits per session.
              </div>
              {errors.resultCount && (
                <div style={{ color: "#DC2626", fontSize: "0.875rem", marginTop: "0.25rem" }}>
                  {errors.resultCount}
                </div>
              )}
            </div>

            <div>
              <label style={{ display: "block", marginBottom: "0.5rem", fontWeight: "500" }}>
                Tone
              </label>
              <input
                type="text"
                name="tone"
                placeholder="Professional, Friendly, etc."
                value={form.tone}
                onChange={(e) => updateField("tone", e.currentTarget.value)}
                style={{
                  width: "100%",
                  padding: "0.5rem",
                  border: "1px solid rgba(11,11,15,0.12)",
                  borderRadius: "12px",
                }}
              />
            </div>

            <div>
              <label style={{ display: "block", marginBottom: "0.5rem", fontWeight: "500" }}>
                Included Collections
              </label>
              <input
                type="text"
                name="includedCollections"
                placeholder='["collection-id-1", "collection-id-2"]'
                value={form.includedCollections}
                onChange={(e) => updateField("includedCollections", e.currentTarget.value)}
                style={{
                  width: "100%",
                  padding: "0.5rem",
                  border: "1px solid rgba(11,11,15,0.12)",
                  borderRadius: "12px",
                }}
              />
            </div>

            <div>
              <label style={{ display: "block", marginBottom: "0.5rem", fontWeight: "500" }}>
                Excluded Tags
              </label>
              <input
                type="text"
                name="excludedTags"
                placeholder='["tag1", "tag2"]'
                value={form.excludedTags}
                onChange={(e) => updateField("excludedTags", e.currentTarget.value)}
                style={{
                  width: "100%",
                  padding: "0.5rem",
                  border: "1px solid rgba(11,11,15,0.12)",
                  borderRadius: "12px",
                }}
              />
            </div>

            <div>
              <label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <input
                  type="checkbox"
                  name="inStockOnly"
                  checked={form.inStockOnly}
                  onChange={(e) => updateField("inStockOnly", e.currentTarget.checked)}
                />
                Only show in-stock items
              </label>
            </div>

            <div>
              <label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <input
                  type="checkbox"
                  name="isDefault"
                  checked={form.isDefault}
                  onChange={(e) => updateField("isDefault", e.currentTarget.checked)}
                />
                Set as default experience
              </label>
            </div>

            <div>
              <label style={{ display: "block", marginBottom: "0.5rem", fontWeight: "500" }}>
                Questions
              </label>
              
              {errors.questionsJson && (
                <div style={{ color: "#DC2626", fontSize: "0.875rem", marginBottom: "0.5rem" }}>
                  {errors.questionsJson}
                </div>
              )}

              <div style={{
                border: errors.questionsJson ? "1px solid #EF4444" : "1px solid rgba(11,11,15,0.12)",
                borderRadius: "12px",
                padding: "1rem",
                backgroundColor: "#FFFFFF",
              }}>
                {questions.length === 0 ? (
                  <div style={{ textAlign: "center", padding: "2rem", color: "rgba(11,11,15,0.62)" }}>
                    No questions yet. Click "Add Question" to get started.
                  </div>
                ) : (
                  questions.map((q, index) => (
                    <div
                      key={index}
                      style={{
                        border: "1px solid rgba(11,11,15,0.12)",
                        borderRadius: "12px",
                        padding: "1rem",
                        marginBottom: "1rem",
                        backgroundColor: "#F9FAFB",
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "0.75rem" }}>
                        <div style={{ fontWeight: "500", fontSize: "0.875rem", color: "rgba(11,11,15,0.62)" }}>
                          Question {index + 1}
                        </div>
                        <div style={{ display: "flex", gap: "0.5rem" }}>
                          <button
                            type="button"
                            onClick={() => {
                              if (index > 0) {
                                const newQuestions = [...questions];
                                [newQuestions[index - 1], newQuestions[index]] = [newQuestions[index], newQuestions[index - 1]];
                                updateQuestions(newQuestions);
                              }
                            }}
                            disabled={index === 0}
                            style={{
                              padding: "0.25rem 0.5rem",
                              backgroundColor: index === 0 ? "rgba(11,11,15,0.2)" : "#7C3AED",
                              color: "#FFFFFF",
                              border: "none",
                              borderRadius: "12px",
                              cursor: index === 0 ? "not-allowed" : "pointer",
                              fontSize: "0.75rem",
                            }}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              if (index < questions.length - 1) {
                                const newQuestions = [...questions];
                                [newQuestions[index], newQuestions[index + 1]] = [newQuestions[index + 1], newQuestions[index]];
                                updateQuestions(newQuestions);
                              }
                            }}
                            disabled={index === questions.length - 1}
                            style={{
                              padding: "0.25rem 0.5rem",
                              backgroundColor: index === questions.length - 1 ? "rgba(11,11,15,0.2)" : "#7C3AED",
                              color: "#FFFFFF",
                              border: "none",
                              borderRadius: "12px",
                              cursor: index === questions.length - 1 ? "not-allowed" : "pointer",
                              fontSize: "0.75rem",
                            }}
                          >
                            ↓
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              const newQuestions = questions.filter((_, i) => i !== index);
                              updateQuestions(newQuestions);
                            }}
                            style={{
                              padding: "0.25rem 0.5rem",
                              backgroundColor: "#EF4444",
                              color: "#FFFFFF",
                              border: "none",
                              borderRadius: "12px",
                              cursor: "pointer",
                              fontSize: "0.75rem",
                            }}
                          >
                            Delete
                          </button>
                        </div>
                      </div>

                      {errors.questions && errors.questions[index] && (
                        <div style={{ color: "#DC2626", fontSize: "0.875rem", marginBottom: "0.5rem" }}>
                          {errors.questions[index]}
                        </div>
                      )}

                      <div style={{ marginBottom: "0.75rem" }}>
                        <label style={{ display: "block", marginBottom: "0.25rem", fontSize: "0.875rem", fontWeight: "500" }}>
                          Question Type
                        </label>
                        <select
                          value={q.type}
                          onChange={(e) => {
                            const newQuestions = [...questions];
                            const newType = e.target.value;
                            newQuestions[index] = {
                              ...newQuestions[index],
                              type: newType,
                              ...(newType === "select"
                                ? { options: newQuestions[index].options || [{ value: "", label: "" }, { value: "", label: "" }] }
                                : newType === "text"
                                ? { placeholder: newQuestions[index].placeholder || "" }
                                : {}),
                            };
                            updateQuestions(newQuestions);
                          }}
                          style={{
                            width: "100%",
                            padding: "0.5rem",
                            border: "1px solid #ccc",
                            borderRadius: "4px",
                          }}
                        >
                          <option value="text">Text</option>
                          <option value="select">Select (Single Choice)</option>
                        </select>
                      </div>

                      <div style={{ marginBottom: "0.75rem" }}>
                        <label style={{ display: "block", marginBottom: "0.25rem", fontSize: "0.875rem", fontWeight: "500" }}>
                          Question Text <span style={{ color: "#DC2626" }}>*</span>
                        </label>
                        <input
                          type="text"
                          value={q.question || ""}
                          onChange={(e) => {
                            const newQuestions = [...questions];
                            newQuestions[index] = { ...newQuestions[index], question: e.target.value };
                            updateQuestions(newQuestions);
                          }}
                          placeholder="Enter question text"
                          style={{
                            width: "100%",
                            padding: "0.5rem",
                            border: "1px solid #ccc",
                            borderRadius: "4px",
                          }}
                        />
                      </div>

                      {q.type === "text" && (
                        <div style={{ marginBottom: "0.75rem" }}>
                          <label style={{ display: "block", marginBottom: "0.25rem", fontSize: "0.875rem", fontWeight: "500" }}>
                            Placeholder (optional)
                          </label>
                          <input
                            type="text"
                            value={q.placeholder || ""}
                            onChange={(e) => {
                              const newQuestions = [...questions];
                              newQuestions[index] = { ...newQuestions[index], placeholder: e.target.value };
                              updateQuestions(newQuestions);
                            }}
                            placeholder="Enter placeholder text"
                            style={{
                              width: "100%",
                              padding: "0.5rem",
                              border: "1px solid #ccc",
                              borderRadius: "4px",
                            }}
                          />
                        </div>
                      )}

                      {q.type === "select" && (
                        <div style={{ marginBottom: "0.75rem" }}>
                          <label style={{ display: "block", marginBottom: "0.5rem", fontSize: "0.875rem", fontWeight: "500" }}>
                            Options <span style={{ color: "#DC2626" }}>*</span> (at least 2 required)
                          </label>
                          {(q.options || []).map((opt: any, optIndex: number) => {
                            const normalizedOpt = typeof opt === "object" ? opt : { value: opt, label: opt };
                            return (
                              <div key={optIndex} style={{ display: "flex", gap: "0.5rem", marginBottom: "0.5rem" }}>
                                <input
                                  type="text"
                                  value={normalizedOpt.value || ""}
                                  onChange={(e) => {
                                    const newQuestions = [...questions];
                                    const currentOptions = [...(newQuestions[index].options || [])];
                                    if (typeof currentOptions[optIndex] === "object") {
                                      currentOptions[optIndex] = { ...currentOptions[optIndex], value: e.target.value };
                                    } else {
                                      currentOptions[optIndex] = { value: e.target.value, label: e.target.value };
                                    }
                                    newQuestions[index] = { ...newQuestions[index], options: currentOptions };
                                    updateQuestions(newQuestions);
                                  }}
                                  placeholder="Value"
                                  style={{
                                    flex: 1,
                                    padding: "0.5rem",
                                    border: "1px solid #ccc",
                                    borderRadius: "4px",
                                  }}
                                />
                                <input
                                  type="text"
                                  value={normalizedOpt.label || ""}
                                  onChange={(e) => {
                                    const newQuestions = [...questions];
                                    const currentOptions = [...(newQuestions[index].options || [])];
                                    if (typeof currentOptions[optIndex] === "object") {
                                      currentOptions[optIndex] = { ...currentOptions[optIndex], label: e.target.value };
                                    } else {
                                      currentOptions[optIndex] = { value: currentOptions[optIndex], label: e.target.value };
                                    }
                                    newQuestions[index] = { ...newQuestions[index], options: currentOptions };
                                    updateQuestions(newQuestions);
                                  }}
                                  placeholder="Label"
                                  style={{
                                    flex: 1,
                                    padding: "0.5rem",
                                    border: "1px solid #ccc",
                                    borderRadius: "4px",
                                  }}
                                />
                                <button
                                  type="button"
                                  onClick={() => {
                                    const newQuestions = [...questions];
                                    const currentOptions = [...(newQuestions[index].options || [])];
                                    currentOptions.splice(optIndex, 1);
                                    newQuestions[index] = { ...newQuestions[index], options: currentOptions };
                                    updateQuestions(newQuestions);
                                  }}
                                  style={{
                                    padding: "0.5rem 1rem",
                                    backgroundColor: "#EF4444",
                                    color: "#FFFFFF",
                                    border: "none",
                                    borderRadius: "12px",
                                    cursor: "pointer",
                                  }}
                                >
                                  Remove
                                </button>
                              </div>
                            );
                          })}
                          <button
                            type="button"
                            onClick={() => {
                              const newQuestions = [...questions];
                              const currentOptions = [...(newQuestions[index].options || [])];
                              currentOptions.push({ value: "", label: "" });
                              newQuestions[index] = { ...newQuestions[index], options: currentOptions };
                              updateQuestions(newQuestions);
                            }}
                            style={{
                              padding: "0.5rem 1rem",
                              backgroundColor: "#10B981",
                              color: "#FFFFFF",
                              border: "none",
                              borderRadius: "12px",
                              cursor: "pointer",
                            }}
                          >
                            Add Option
                          </button>
                        </div>
                      )}
                    </div>
                  ))
                )}

                <button
                  type="button"
                  onClick={() => {
                    const newQuestions = [...questions, { type: "text", question: "", placeholder: "" }];
                    updateQuestions(newQuestions);
                  }}
                  style={{
                    padding: "0.75rem 1.5rem",
                    background: "linear-gradient(135deg, #7C3AED, #06B6D4)",
                    color: "#FFFFFF",
                    border: "none",
                    borderRadius: "12px",
                    cursor: "pointer",
                    fontSize: "1rem",
                    width: "100%",
                    fontWeight: "500",
                    boxShadow: "0 4px 12px rgba(124, 58, 237, 0.3)",
                  }}
                >
                  Add Question
                </button>
              </div>

              <input type="hidden" name="questionsJson" value={form.questionsJson} />
            </div>

          </s-stack>
        </s-section>

        <div style={{ marginTop: "2rem", display: "flex", gap: "1rem" }}>
          <button
            type="submit"
            disabled={isSubmitting || isLimitReached}
            style={{
              padding: "0.75rem 1.5rem",
              background: isLimitReached 
                ? "rgba(11,11,15,0.2)" 
                : "linear-gradient(135deg, #7C3AED, #06B6D4)",
              color: "#FFFFFF",
              border: "none",
              borderRadius: "12px",
              cursor: (isSubmitting || isLimitReached) ? "not-allowed" : "pointer",
              fontSize: "1rem",
              fontWeight: "500",
              boxShadow: isLimitReached ? "none" : "0 4px 12px rgba(124, 58, 237, 0.3)",
            }}
          >
            {isSubmitting ? "Creating..." : isLimitReached ? "Limit Reached" : "Create Experience"}
          </button>
          <button
            type="button"
            onClick={() => navigate("/app/experiences")}
            style={{
              padding: "0.75rem 1.5rem",
              backgroundColor: "#F9FAFB",
              color: "#0B0B0F",
              border: "1px solid rgba(11,11,15,0.12)",
              borderRadius: "12px",
              cursor: "pointer",
              fontSize: "1rem",
            }}
          >
            Cancel
          </button>
        </div>
      </Form>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

/*
 * TESTING CHECKLIST for New Experience Page:
 * 
 * 1. Mode Dropdown:
 *    - Select "Guided Quiz" and verify it saves as "quiz"
 *    - Select "Chat" and verify it saves as "chat"
 *    - Select "Hybrid (quiz then chat)" and verify it saves as "hybrid"
 *    - Verify dropdown value persists after form validation errors
 *    - Verify mode is required (cannot submit empty)
 * 
 * 2. Result Count Dropdown:
 *    - Select 8, 12, or 16 and verify it saves correctly
 *    - Verify only allowed values (8, 12, 16) can be selected
 *    - Verify plan limits are respected (disabled options shown if plan doesn't allow)
 *    - Verify dropdown value persists after form validation errors
 *    - Verify result count is required (cannot submit empty)
 * 
 * 3. Form Submission:
 *    - Fill all required fields and submit
 *    - Verify experience is created successfully
 *    - Verify redirect to experiences list page
 *    - Verify new experience appears in list
 * 
 * 4. Validation:
 *    - Try submitting with empty name (should show error)
 *    - Try submitting with invalid mode (should show error)
 *    - Try submitting with invalid result count (should show error)
 *    - Verify error messages are clear and helpful
 * 
 * 5. Default Experience:
 *    - Check "Set as default experience" checkbox
 *    - Create experience and verify it becomes default
 *    - Verify any previous default experience is unset
 * 
 * 6. Error Logging:
 *    - Check browser console for clear error logs if submission fails
 *    - Verify server-side logs show detailed error information
 */

