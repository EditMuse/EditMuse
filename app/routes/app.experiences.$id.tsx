import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useLoaderData, useActionData, useNavigation, useNavigate } from "react-router";
import { authenticate } from "~/shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { HeadersFunction } from "react-router";
import prisma from "~/db.server";
import { useState, useEffect } from "react";
import { isResultCountAllowed, getCurrentPlan } from "~/models/billing.server";
import { withQuery } from "~/utils/redirect.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { id } = params;

  const shop = await prisma.shop.findUnique({
    where: { domain: session.shop },
  });

  if (!shop) {
    throw new Response("Not Found", { status: 404 });
  }

  const experience = await prisma.experience.findFirst({
    where: {
      id: id!,
      shopId: shop.id,
    },
  });

  if (!experience) {
    throw new Response("Not Found", { status: 404 });
  }

  const questionsJson = (experience as any).questionsJson || "[]";
  let parsedQuestions: any[] = [];
  try {
    parsedQuestions = JSON.parse(questionsJson);
  } catch {
    parsedQuestions = [];
  }

  // Normalize questions: convert "prompt" to "question", normalize types, normalize options
  if (Array.isArray(parsedQuestions) && parsedQuestions.length > 0) {
    parsedQuestions = parsedQuestions.map((q: any) => {
      const normalized: any = { ...q };
      
      // Use "question" field, fallback to "prompt" for backward compatibility
      if (normalized.prompt && !normalized.question) {
        normalized.question = normalized.prompt;
        delete normalized.prompt;
      }
      
      // Normalize type names: single_select -> select, filter out unsupported types
      if (normalized.type === "single_select") {
        normalized.type = "select";
      } else if (normalized.type === "boolean" || normalized.type === "yesno" || normalized.type === "multiselect") {
        // Convert unsupported types to text
        normalized.type = "text";
        delete normalized.options; // Remove options if converting from select type
      }
      
      // Normalize options to {value, label} format (only for select type)
      if (normalized.type === "select" && normalized.options) {
        normalized.options = normalized.options.map((opt: any) => {
          if (typeof opt === "string") {
            return { value: opt, label: opt };
          }
          if (typeof opt === "object" && opt.value !== undefined) {
            return { value: String(opt.value), label: String(opt.label || opt.value) };
          }
          return { value: String(opt), label: String(opt) };
        });
      }
      
      return normalized;
    })
    .filter((q: any) => q.type === "text" || q.type === "select"); // Only keep supported types
  } else {
    // Seed with default questions if empty
    parsedQuestions = [
      {
        type: "text",
        question: "What are you looking for?",
      },
      {
        type: "select",
        question: "Budget range",
        options: [
          { value: "under-25", label: "Under $25" },
          { value: "25-50", label: "$25 - $50" },
          { value: "50-100", label: "$50 - $100" },
          { value: "100-250", label: "$100 - $250" },
          { value: "250-plus", label: "$250+" },
        ],
      },
      {
        type: "text",
        question: "Any preferences? (brand, color, size, features)",
      },
    ];
  }

  // Normalize invalid mode to "hybrid"
  const validModes = ["quiz", "chat", "hybrid"];
  const normalizedMode = validModes.includes(experience.mode) ? experience.mode : "hybrid";

  const { getMaxResultCount } = await import("~/models/billing.server");
  const maxResultCount = await getMaxResultCount(shop.id);

  return {
    experience: {
      ...experience,
      mode: normalizedMode, // Normalized mode
      includedCollections: JSON.parse(experience.includedCollections || "[]"),
      excludedTags: JSON.parse(experience.excludedTags || "[]"),
      isDefault: (experience as any).isDefault || false,
      questionsJson: JSON.stringify(parsedQuestions),
      questions: parsedQuestions,
    },
    maxResultCount,
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { id } = params;

  const shop = await prisma.shop.findUnique({
    where: { domain: session.shop },
  });

  if (!shop) {
    throw new Response("Not Found", { status: 404 });
  }

  const existing = await prisma.experience.findFirst({
    where: {
      id: id!,
      shopId: shop.id,
    },
  });

  if (!existing) {
    throw new Response("Not Found", { status: 404 });
  }

  const formData = await request.formData();
  const actionType = formData.get("actionType") as string;

  console.log("[EditExperience] Action started", { experienceId: id, actionType, shop: session.shop });

  // Handle delete action
  if (actionType === "delete") {
    try {
      console.log("[EditExperience] Deleting experience", { experienceId: id });
      await prisma.experience.delete({
        where: { id: id! },
      });
      console.log("[EditExperience] Successfully deleted experience", { experienceId: id });
      return redirect(withQuery(request, "/app/experiences"));
    } catch (error) {
      console.error("[EditExperience] Error deleting experience:", error);
      return { error: error instanceof Error ? error.message : "Failed to delete experience" };
    }
  }

  // Handle update action
  const name = formData.get("name") as string;
  const mode = formData.get("mode") as string;
  const resultCountStr = formData.get("resultCount") as string;
  const tone = formData.get("tone") as string | null;
  const includedCollections = formData.get("includedCollections") as string || "[]";
  const excludedTags = formData.get("excludedTags") as string || "[]";
  const inStockOnly = formData.get("inStockOnly") === "true" || formData.get("inStockOnly") === "on";
  const isDefault = formData.get("isDefault") === "true" || formData.get("isDefault") === "on";
  const questionsJson = formData.get("questionsJson") as string || "[]";

  console.log("[EditExperience] Form data received", { 
    name, 
    mode, 
    resultCountStr, 
    inStockOnly, 
    isDefault 
  });

  // Validate mode
  const validModes = ["quiz", "chat", "hybrid"];
  if (!mode || !validModes.includes(mode)) {
    console.error("[EditExperience] Validation error: Invalid mode", { mode, validModes });
    return { error: "Mode must be one of: quiz, chat, hybrid" };
  }

  // Validate resultCount
  const resultCount = parseInt(resultCountStr, 10);
  if (isNaN(resultCount) || ![8, 12, 16].includes(resultCount)) {
    console.error("[EditExperience] Validation error: Invalid result count", { resultCountStr, resultCount });
    return { error: "Result count must be 8, 12, or 16" };
  }

  // Check plan limits
  const isAllowed = await isResultCountAllowed(shop.id, resultCount);
  if (!isAllowed) {
    const plan = await getCurrentPlan(shop.id);
    return { 
      error: `Your ${plan.name} plan allows up to ${plan.resultCount} results. Please upgrade to use ${resultCount} results.` 
    };
  }

  // Validate questionsJson - allow 0 questions for chat mode
  let parsedQuestions: any[] = [];
  try {
    if (questionsJson && questionsJson.trim() !== "") {
      parsedQuestions = JSON.parse(questionsJson);
      if (!Array.isArray(parsedQuestions)) {
        return { error: "Questions must be a JSON array" };
      }
      
      // Validate - allow 0 questions for chat mode, require at least 1 for quiz/hybrid
      if (parsedQuestions.length === 0 && mode !== "chat") {
        return { error: "At least one question is required for guided quiz and hybrid modes" };
      }
    } else {
      // Empty questionsJson - allow for chat mode
      if (mode !== "chat") {
        return { error: "At least one question is required for guided quiz and hybrid modes" };
      }
      parsedQuestions = [];
    }
      
      // Validate and normalize each question
      const validTypes = ["text", "select"];
      for (let i = 0; i < parsedQuestions.length; i++) {
        const q = parsedQuestions[i];
        if (!q.type || !validTypes.includes(q.type)) {
          return { error: `Question ${i + 1}: type must be "text" or "select"` };
        }
        // Normalize "prompt" to "question" if present
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
    }
  } catch (e) {
    return { error: "Questions must be valid JSON array" };
  }

  try {
    // Use a transaction to ensure only one default experience per shop
    await prisma.$transaction(async (tx) => {
      // If setting default, unset all other defaults for this shop first
      if (isDefault) {
        await tx.experience.updateMany({
          where: {
            shopId: shop.id,
            isDefault: true,
          },
          data: {
            isDefault: false,
          },
        });
      }

      // Update the experience
      await tx.experience.update({
        where: { id: id! },
        data: {
          name,
          mode,
          resultCount,
          tone: tone || null,
          includedCollections,
          excludedTags,
          inStockOnly,
          isDefault,
          questionsJson: JSON.stringify(parsedQuestions),
        },
      });
    });

    console.log("[EditExperience] Successfully updated experience", { experienceId: id, name, mode, resultCount });
    return redirect(withQuery(request, "/app/experiences"));
  } catch (error) {
    console.error("[EditExperience] Error updating experience:", error);
    return { error: error instanceof Error ? error.message : "Failed to update experience" };
  }
};

export default function EditExperience() {
  const { experience, maxResultCount } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const isSubmitting = navigation.state === "submitting";

  // Get questions from experience (already normalized and seeded by loader)
  const initialQuestions = Array.isArray(experience.questions) && experience.questions.length > 0
    ? experience.questions
    : [];

  // Form state initialized from experience
  const [form, setForm] = useState({
    name: experience.name,
    mode: experience.mode,
    resultCount: experience.resultCount,
    tone: experience.tone || "",
    includedCollections: Array.isArray(experience.includedCollections) 
      ? JSON.stringify(experience.includedCollections) 
      : (experience.includedCollections || "[]"),
    excludedTags: Array.isArray(experience.excludedTags)
      ? JSON.stringify(experience.excludedTags)
      : (experience.excludedTags || "[]"),
    inStockOnly: experience.inStockOnly,
    isDefault: experience.isDefault || false,
    questionsJson: JSON.stringify(initialQuestions),
  });

  // Questions state for the builder UI
  const [questions, setQuestions] = useState<any[]>(initialQuestions);

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
      setErrors((prev) => ({ ...prev, questions: undefined }));
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

    // Validate questions - allow 0 questions for chat mode
    if (questions.length === 0 && form.mode !== "chat") {
      newErrors.questionsJson = "At least one question is required for guided quiz and hybrid modes";
    } else if (questions.length > 0) {
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

  // Handle form submit
  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    if (!validate()) {
      e.preventDefault();
      return false;
    }
    // Form will submit normally via React Router
  };

  return (
    <s-page heading="Edit Experience">
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
            <s-text-field
              label="Name"
              name="name"
              required
              value={form.name}
              onChange={(e) => updateField("name", e.currentTarget.value)}
              error={errors.name}
            />

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
              {maxResultCount < 16 && (
                <div style={{ fontSize: "0.875rem", color: "rgba(11,11,15,0.62)", marginTop: "0.25rem" }}>
                  Your plan allows up to {maxResultCount} results. <a href="/app/billing">Upgrade</a> to unlock more.
                </div>
              )}
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
                value={form.tone}
                onChange={(e) => updateField("tone", e.currentTarget.value)}
                placeholder="Professional, Friendly, etc."
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
                value={form.includedCollections}
                onChange={(e) => updateField("includedCollections", e.currentTarget.value)}
                placeholder='["collection-id-1", "collection-id-2"]'
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
                value={form.excludedTags}
                onChange={(e) => updateField("excludedTags", e.currentTarget.value)}
                placeholder='["tag1", "tag2"]'
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
                            Remove
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
                    const newQuestions = [...questions, { type: "text", question: "" }];
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
          <input type="hidden" name="actionType" value="update" />
          <button
            type="submit"
            disabled={isSubmitting}
            style={{
              padding: "0.75rem 1.5rem",
              background: "linear-gradient(135deg, #7C3AED, #06B6D4)",
              color: "#FFFFFF",
              border: "none",
              borderRadius: "12px",
              cursor: isSubmitting ? "not-allowed" : "pointer",
              fontSize: "1rem",
              fontWeight: "500",
              boxShadow: "0 4px 12px rgba(124, 58, 237, 0.3)",
            }}
          >
            {isSubmitting ? "Saving..." : "Save Experience"}
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

        <div style={{ marginTop: "2rem" }}>
          <div style={{ 
            padding: "1rem", 
            backgroundColor: "#FFFBEB", 
            border: "1px solid #FCD34D",
            borderRadius: "12px"
          }}>
            <strong style={{ color: "#D97706" }}>Danger Zone</strong>
            <Form method="post" style={{ marginTop: "0.5rem" }}>
              <input type="hidden" name="actionType" value="delete" />
              <button
                type="submit"
                disabled={isSubmitting}
                onClick={(e) => {
                  if (!confirm(`Are you sure you want to delete "${experience.name}"? This action cannot be undone.`)) {
                    e.preventDefault();
                  }
                }}
                style={{
                  padding: "0.75rem 1.5rem",
                  backgroundColor: "#EF4444",
                  color: "#FFFFFF",
                  border: "none",
                  borderRadius: "12px",
                  cursor: isSubmitting ? "not-allowed" : "pointer",
                  fontSize: "1rem",
                  fontWeight: "500",
                }}
              >
                {isSubmitting ? "Deleting..." : "Delete experience"}
              </button>
            </Form>
          </div>
        </div>
      </Form>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

/*
 * TESTING CHECKLIST for Edit Experience Page:
 * 
 * 1. Mode Dropdown:
 *    - Change mode from current value to another option
 *    - Verify dropdown shows current experience mode on load
 *    - Select "Guided Quiz", "Chat", or "Hybrid" and verify it saves correctly
 *    - Verify dropdown value persists after form validation errors
 *    - Verify mode is required (cannot submit empty)
 * 
 * 2. Result Count Dropdown:
 *    - Change result count from current value to another option
 *    - Verify dropdown shows current experience result count on load
 *    - Select 8, 12, or 16 and verify it saves correctly
 *    - Verify only allowed values (8, 12, 16) can be selected
 *    - Verify plan limits are respected (disabled options shown if plan doesn't allow)
 *    - Verify dropdown value persists after form validation errors
 *    - Verify result count is required (cannot submit empty)
 * 
 * 3. Form Submission:
 *    - Modify experience fields and save
 *    - Verify changes are persisted correctly
 *    - Verify redirect to experiences list page
 *    - Verify updated experience shows new values in list
 * 
 * 4. Validation:
 *    - Try submitting with empty name (should show error)
 *    - Try submitting with invalid mode (should show error)
 *    - Try submitting with invalid result count (should show error)
 *    - Verify error messages are clear and helpful
 * 
 * 5. Default Experience:
 *    - Toggle "Set as default experience" checkbox
 *    - Save and verify default status is updated
 *    - Verify any previous default experience is unset
 * 
 * 6. Delete Experience:
 *    - Click "Delete experience" button in Danger Zone
 *    - Verify confirmation dialog appears
 *    - Cancel deletion and verify experience still exists
 *    - Confirm deletion and verify:
 *      a) Experience is deleted
 *      b) Redirect to experiences list
 *      c) Experience no longer appears in list
 * 
 * 7. Shop Scoping:
 *    - Verify only experiences belonging to current shop can be edited
 *    - Try accessing another shop's experience ID (should get 404)
 * 
 * 8. Error Logging:
 *    - Check browser console for clear error logs if submission fails
 *    - Verify server-side logs show detailed error information
 */

